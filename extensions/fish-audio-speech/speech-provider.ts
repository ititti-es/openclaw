// Fish Audio provider maps OpenClaw speech contracts to the hosted S2.1 API.
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import {
  parseSpeechDirectiveNumberOverride,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asBoolean,
  asFiniteNumberInRange,
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FISH_AUDIO_STREAM_MAX_BYTES,
  type FishAudioFormat,
  type FishAudioLatency,
  type FishAudioTtsRequest,
  fishAudioTts,
  fishAudioTtsStream,
  listFishAudioVoices,
  normalizeFishAudioBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
} from "./tts.js";

const FISH_AUDIO_MODELS = ["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1"] as const;
const DEFAULT_MODEL = "s2.1-pro";
const DEFAULT_OPENAI_COMPATIBLE_MODEL = "fish-s2.1-pro-free";
const DEFAULT_LATENCY: FishAudioLatency = "balanced";
const DEFAULT_TIMEOUT_MS = 240_000;

type FishAudioProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  transport: "fish" | "openai-compatible";
  model: string;
  voice?: string;
  inputReferences?: unknown[];
  referenceId?: string;
  latency?: FishAudioLatency;
  speed?: number;
  temperature?: number;
  topP?: number;
  normalize?: boolean;
};

type FishAudioOverrides = Partial<Omit<FishAudioProviderConfig, "apiKey" | "baseUrl">>;

function normalizeModel(value: unknown, transport: "fish" | "openai-compatible" = "fish"): string {
  const model = trimToUndefined(value);
  if (!model) {
    return transport === "openai-compatible" ? DEFAULT_OPENAI_COMPATIBLE_MODEL : DEFAULT_MODEL;
  }
  if (transport === "openai-compatible") {
    return model;
  }
  if (FISH_AUDIO_MODELS.some((candidate) => candidate === model)) {
    return model;
  }
  throw new Error(`invalid Fish Audio model "${model}"`);
}

function normalizeLatency(value: unknown): FishAudioLatency {
  const latency = trimToUndefined(value)?.toLowerCase();
  if (!latency) {
    return DEFAULT_LATENCY;
  }
  if (latency === "low" || latency === "balanced" || latency === "normal") {
    return latency;
  }
  throw new Error(`invalid Fish Audio latency "${latency}"`);
}

function normalizeNumber(value: unknown, min: number, max: number): number | undefined {
  return asFiniteNumberInRange(value, { min, max });
}

function resolveReferenceId(raw: Record<string, unknown> | undefined): string | undefined {
  return trimToUndefined(raw?.speakerVoiceId ?? raw?.voiceId ?? raw?.referenceId);
}

function normalizeTransport(value: unknown): "fish" | "openai-compatible" {
  if (value === undefined || value === "fish") {
    return "fish";
  }
  if (value === "openai-compatible") {
    return "openai-compatible";
  }
  throw new Error(`invalid Fish Audio transport "${String(value)}"`);
}

function normalizeProviderConfig(rawConfig: Record<string, unknown>): FishAudioProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw =
    asOptionalRecord(providers?.["fish-audio"]) ?? asOptionalRecord(rawConfig["fish-audio"]);
  return readProviderConfig(raw ?? {});
}

function readProviderConfig(config: SpeechProviderConfig): FishAudioProviderConfig {
  const raw = asOptionalRecord(config) ?? {};
  const transport = normalizeTransport(raw.transport);
  if (transport === "openai-compatible") {
    assertOpenAICompatibleOptions(raw);
  }
  const inputReferences = raw.input_references ?? raw.inputReferences;
  if (transport === "fish" && inputReferences !== undefined) {
    throw new Error(
      "input_references requires OpenAI-compatible transport; Fish Audio uses referenceId",
    );
  }
  if (
    inputReferences !== undefined &&
    (!Array.isArray(inputReferences) || !inputReferences.length)
  ) {
    throw new Error(
      "OpenAI-compatible input_references must be a nonempty array of reference parts",
    );
  }
  return {
    transport,
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "tts.providers.fish-audio.apiKey",
    }),
    baseUrl:
      transport === "openai-compatible"
        ? normalizeOpenAICompatibleBaseUrl(trimToUndefined(raw.baseUrl ?? raw.baseURL))
        : normalizeFishAudioBaseUrl(trimToUndefined(raw.baseUrl)),
    model: normalizeModel(raw.model ?? raw.modelId, transport),
    voice: trimToUndefined(raw.voice ?? raw.speakerVoiceId ?? raw.voiceId),
    inputReferences: Array.isArray(inputReferences) ? inputReferences : undefined,
    referenceId: transport === "fish" ? resolveReferenceId(raw) : undefined,
    latency: transport === "fish" ? normalizeLatency(raw.latency) : undefined,
    speed: normalizeNumber(raw.speed, 0.5, 2),
    temperature: normalizeNumber(raw.temperature, 0, 1),
    topP: normalizeNumber(raw.topP ?? raw.top_p, 0, 1),
    normalize: asBoolean(raw.normalize),
  };
}

function assertOpenAICompatibleOptions(raw: Record<string, unknown>): void {
  for (const key of [
    "referenceId",
    "latency",
    "temperature",
    "topP",
    "top_p",
    "normalize",
    "sampleRate",
    "sample_rate",
  ]) {
    if (raw[key] !== undefined) {
      throw new Error(
        `OpenAI-compatible transport does not support Fish Audio ${key}; use model aliases or input_references for cloning`,
      );
    }
  }
}

function readOverrides(
  overrides: SpeechProviderOverrides | undefined,
  transport: "fish" | "openai-compatible",
): FishAudioOverrides {
  const raw = asOptionalRecord(overrides) ?? {};
  if (transport === "openai-compatible") {
    assertOpenAICompatibleOptions(raw);
  }
  return {
    voice: trimToUndefined(raw.voice ?? raw.speakerVoiceId ?? raw.voiceId),
    model: trimToUndefined(raw.model ?? raw.modelId)
      ? normalizeModel(raw.model ?? raw.modelId, transport)
      : undefined,
    referenceId: transport === "fish" ? resolveReferenceId(raw) : undefined,
    latency: trimToUndefined(raw.latency) ? normalizeLatency(raw.latency) : undefined,
    speed: normalizeNumber(raw.speed, 0.5, 2),
    temperature: normalizeNumber(raw.temperature, 0, 1),
    topP: normalizeNumber(raw.topP ?? raw.top_p, 0, 1),
    normalize: asBoolean(raw.normalize),
  };
}

function resolveApiKey(config: FishAudioProviderConfig): string | undefined {
  if (config.transport === "openai-compatible") {
    return resolveSpeechProviderApiKey(config.apiKey, process.env.OPENAI_COMPATIBLE_API_KEY);
  }
  return resolveSpeechProviderApiKey(
    config.apiKey,
    process.env.FISH_API_KEY,
    process.env.FISH_AUDIO_API_KEY,
  );
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "referenceid":
    case "reference_id":
    case "fish_voice":
    case "fishaudio_voice":
      return ctx.policy.allowVoice
        ? {
            handled: true,
            overrides: {
              ...ctx.currentOverrides,
              [ctx.providerConfig?.transport === "openai-compatible" &&
              !ctx.key.includes("reference")
                ? "voice"
                : "referenceId"]: ctx.value,
            },
          }
        : { handled: true };
    case "model":
    case "modelid":
    case "model_id":
    case "fish_model":
    case "fishaudio_model":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      try {
        return {
          handled: true,
          overrides: {
            ...ctx.currentOverrides,
            model: normalizeModel(ctx.value, normalizeTransport(ctx.providerConfig?.transport)),
          },
        };
      } catch (error) {
        return { handled: true, warnings: [String(error)] };
      }
    case "speed":
    case "fish_speed":
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid Fish Audio speed "${value}"`,
      });
    case "temperature":
    case "fish_temperature":
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "temperature",
        range: { min: 0, max: 1 },
        warning: (value) => `invalid Fish Audio temperature "${value}"`,
      });
    case "top_p":
    case "topp":
    case "fish_top_p":
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "topP",
        range: { min: 0, max: 1 },
        warning: (value) => `invalid Fish Audio top_p "${value}"`,
      });
    case "latency":
    case "fish_latency":
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      try {
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, latency: normalizeLatency(ctx.value) },
        };
      } catch (error) {
        return { handled: true, warnings: [String(error)] };
      }
    case "normalize":
    case "fish_normalize": {
      if (!ctx.policy.allowNormalization) {
        return { handled: true };
      }
      const normalize = parseBooleanValue(ctx.value);
      if (normalize !== undefined) {
        return { handled: true, overrides: { ...ctx.currentOverrides, normalize } };
      }
      return { handled: true, warnings: [`invalid Fish Audio normalize "${ctx.value}"`] };
    }
    default:
      return { handled: false };
  }
}

function resolveFormat(target: SpeechSynthesisTarget): {
  format: FishAudioFormat;
  sampleRate?: number;
  fileExtension: string;
  voiceCompatible: boolean;
} {
  if (target === "voice-note") {
    return { format: "opus", sampleRate: 48_000, fileExtension: ".opus", voiceCompatible: true };
  }
  if (target === "telephony") {
    return { format: "pcm", sampleRate: 8_000, fileExtension: ".pcm", voiceCompatible: false };
  }
  return { format: "mp3", sampleRate: 44_100, fileExtension: ".mp3", voiceCompatible: false };
}

function resolveSynthesisRequest(
  req: Pick<
    SpeechSynthesisRequest,
    "cfg" | "providerConfig" | "providerOverrides" | "text" | "timeoutMs" | "target"
  >,
): Omit<FishAudioTtsRequest, "maxBytes"> & { fileExtension: string; voiceCompatible: boolean } {
  const config = readProviderConfig(req.providerConfig);
  const overrides = readOverrides(req.providerOverrides, config.transport);
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new Error(
      config.transport === "openai-compatible"
        ? "OpenAI-compatible API key missing"
        : "Fish Audio API key missing",
    );
  }
  if (config.transport === "openai-compatible" && req.target === "telephony") {
    throw new Error(
      "OpenAI-compatible transport does not support telephony: PCM sample rate is not guaranteed to be 8 kHz",
    );
  }
  const output = resolveFormat(req.target);
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    transport: config.transport,
    voice: overrides.voice ?? config.voice,
    inputReferences: config.inputReferences,
    model: overrides.model ?? config.model,
    referenceId: overrides.referenceId ?? config.referenceId,
    latency: overrides.latency ?? config.latency,
    speed: overrides.speed ?? config.speed,
    temperature: overrides.temperature ?? config.temperature,
    topP: overrides.topP ?? config.topP,
    normalize: overrides.normalize ?? config.normalize,
    timeoutMs: req.timeoutMs,
    ...output,
    ...(config.transport === "openai-compatible" ? { sampleRate: undefined } : {}),
  };
}

export function buildFishAudioSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "fish-audio",
    label: "Fish Audio",
    autoSelectOrder: 28,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultModel: DEFAULT_MODEL,
    models: FISH_AUDIO_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const providers = asOptionalRecord(baseTtsConfig.providers);
      const base =
        asOptionalRecord(providers?.["fish-audio"]) ??
        asOptionalRecord(baseTtsConfig["fish-audio"]) ??
        {};
      const changedTransport =
        talkProviderConfig.transport !== undefined &&
        talkProviderConfig.transport !== normalizeTransport(base.transport);
      return readProviderConfig({
        ...(changedTransport ? {} : base),
        ...(resolveReferenceId(talkProviderConfig) || trimToUndefined(talkProviderConfig.voice)
          ? {
              speakerVoiceId: undefined,
              voiceId: undefined,
              referenceId: undefined,
              voice: undefined,
            }
          : {}),
        ...talkProviderConfig,
        ...(talkProviderConfig.modelId === undefined ? {} : { model: talkProviderConfig.modelId }),
        ...(talkProviderConfig.baseURL === undefined
          ? {}
          : { baseUrl: talkProviderConfig.baseURL }),
      });
    },
    resolveTalkOverrides: ({ params }) => {
      const { model, modelId, ...rest } = params;
      const overrides = {
        ...rest,
        model: trimToUndefined(modelId ?? model),
        voiceId: trimToUndefined(rest.voiceId),
      };
      return Object.fromEntries(
        Object.entries(overrides).filter(([, value]) => value !== undefined),
      );
    },
    listVoices: async (req) => {
      const config = readProviderConfig(req.providerConfig ?? {});
      if (config.transport === "openai-compatible") {
        if (!config.voice) {
          throw new Error(
            "OpenAI-compatible voice discovery is unsupported; configure voice or use a model alias",
          );
        }
        return [{ id: config.voice }];
      }
      const apiKey = resolveApiKey({
        ...config,
        apiKey: trimToUndefined(req.apiKey) ?? config.apiKey,
      });
      if (!apiKey) {
        throw new Error("Fish Audio API key missing");
      }
      return await listFishAudioVoices({
        apiKey,
        baseUrl: normalizeFishAudioBaseUrl(trimToUndefined(req.baseUrl) ?? config.baseUrl),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveApiKey(readProviderConfig(providerConfig))),
    synthesize: async (req) => {
      const params = resolveSynthesisRequest(req);
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      return {
        audioBuffer: await fishAudioTts({
          ...params,
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
        }),
        outputFormat: params.format,
        fileExtension: params.fileExtension,
        voiceCompatible: params.voiceCompatible,
      };
    },
    streamSynthesize: async (req) => {
      const params = resolveSynthesisRequest(req);
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      const stream = await fishAudioTtsStream({
        ...params,
        maxBytes: Math.min(
          resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
          FISH_AUDIO_STREAM_MAX_BYTES,
        ),
      });
      return {
        audioStream: stream.audioStream,
        outputFormat: params.format,
        fileExtension: params.fileExtension,
        voiceCompatible: params.voiceCompatible,
        release: stream.release,
      };
    },
    synthesizeTelephony: async (req) => {
      const params = resolveSynthesisRequest({ ...req, target: "telephony" });
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      return {
        audioBuffer: await fishAudioTts({
          ...params,
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
        }),
        outputFormat: "pcm",
        sampleRate: 8_000,
      };
    },
  };
}
