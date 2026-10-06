import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
// Fish Audio HTTP client for buffered and streaming TTS plus voice discovery.
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const FISH_AUDIO_BASE_URL = "https://api.fish.audio";
const FISH_AUDIO_VOICES_MAX_BYTES = 2 * 1024 * 1024;
const FISH_AUDIO_VOICE_PAGE_SIZE = 100;
const FISH_AUDIO_MAX_OWN_VOICE_PAGES = 20;

export type FishAudioModel = "s2.1-pro-free" | "s2.1-pro" | "s2-pro" | "s1";
export type FishAudioLatency = "low" | "balanced" | "normal";
export type FishAudioFormat = "mp3" | "opus" | "wav" | "pcm";

export type FishAudioTtsRequest = {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  transport?: "fish" | "liminal";
  voice?: string;
  inputReferences?: unknown[];
  referenceId?: string;
  format: FishAudioFormat;
  sampleRate?: number;
  latency?: FishAudioLatency;
  speed?: number;
  temperature?: number;
  topP?: number;
  normalize?: boolean;
  timeoutMs: number;
  maxBytes: number;
};

export function normalizeFishAudioBaseUrl(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/u, "") : FISH_AUDIO_BASE_URL;
}

export function normalizeLiminalBaseUrl(value?: string): string {
  const baseUrl = value?.trim().replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new Error("Liminal transport requires baseUrl (or baseURL)");
  }
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function buildFishAudioRequestBody(params: FishAudioTtsRequest): string {
  if (params.transport === "liminal") {
    return JSON.stringify({
      model: params.model,
      input: params.text,
      voice: params.voice ?? "alloy",
      response_format: params.format,
      ...(params.speed == null ? {} : { speed: params.speed }),
      ...(params.inputReferences ? { input_references: params.inputReferences } : {}),
    });
  }
  return JSON.stringify({
    text: params.text,
    format: params.format,
    ...(params.referenceId ? { reference_id: params.referenceId } : {}),
    ...(params.sampleRate == null ? {} : { sample_rate: params.sampleRate }),
    ...(params.latency == null ? {} : { latency: params.latency }),
    ...(params.speed == null ? {} : { prosody: { speed: params.speed } }),
    ...(params.temperature == null ? {} : { temperature: params.temperature }),
    ...(params.topP == null ? {} : { top_p: params.topP }),
    ...(params.normalize == null ? {} : { normalize: params.normalize }),
  });
}

async function requestFishAudioTts(params: FishAudioTtsRequest): Promise<{
  response: Response;
  release: () => Promise<void>;
}> {
  const liminal = params.transport === "liminal";
  const baseUrl = liminal
    ? normalizeLiminalBaseUrl(params.baseUrl)
    : normalizeFishAudioBaseUrl(params.baseUrl);
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  return await fetchWithSsrFGuard({
    url: liminal ? `${baseUrl}/audio/speech` : `${baseUrl}/v1/tts`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        ...(liminal ? {} : { model: params.model }),
      },
      body: buildFishAudioRequestBody(params),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: liminal ? "fish-audio.liminal.tts" : "fish-audio.tts",
  });
}

export async function fishAudioTts(params: FishAudioTtsRequest): Promise<Buffer> {
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const label = params.transport === "liminal" ? "Liminal TTS" : "Fish Audio TTS";
  const { response, release } = await requestFishAudioTts(params);
  try {
    await assertOkOrThrowProviderError(response, `${label} API error`);
    return await readProviderBinaryResponse(response, `${label} API error`, "audio", {
      maxBytes: params.maxBytes,
    });
  } finally {
    await release();
  }
}

export async function fishAudioTtsStream(params: FishAudioTtsRequest): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const { createBoundedProviderBinaryStream } =
    await import("openclaw/plugin-sdk/provider-binary-stream");
  const { assertOkOrThrowProviderError, assertProviderBinaryResponseContent } =
    await import("openclaw/plugin-sdk/provider-http");
  const label = params.transport === "liminal" ? "Liminal TTS" : "Fish Audio TTS";
  const { response, release } = await requestFishAudioTts(params);
  let handedOff = false;
  try {
    await assertOkOrThrowProviderError(response, `${label} API error`);
    assertProviderBinaryResponseContent(response, `${label} API error`, "audio");
    if (!response.body) {
      throw new Error(`${label} API response missing audio stream`);
    }
    const bounded = createBoundedProviderBinaryStream(response.body, {
      maxBytes: params.maxBytes,
      createOverflowError: ({ maxBytes }) =>
        new Error(`${label} API error: audio response exceeds ${maxBytes} bytes`),
      createReleaseError: () => new Error(`${label} stream released`),
      cleanup: release,
    });
    handedOff = true;
    return { audioStream: bounded.stream, release: bounded.release };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}

type FishAudioVoicePayload = {
  total?: number;
  items?: unknown[];
};

function parseVoiceItem(value: unknown): SpeechVoiceOption | undefined {
  const item = asOptionalRecord(value);
  const id = trimToUndefined(item?.["_id"]);
  if (!id) {
    return undefined;
  }
  const languages = Array.isArray(item?.languages)
    ? item.languages.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
  const tags = Array.isArray(item?.tags)
    ? item.tags.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
  return {
    id,
    name: trimToUndefined(item?.title),
    description: trimToUndefined(item?.description),
    category: trimToUndefined(item?.visibility),
    locale: languages[0],
    personalities: tags.length > 0 ? tags : undefined,
  };
}

async function requestVoicePage(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  self: boolean;
  pageNumber: number;
}): Promise<FishAudioVoicePayload> {
  const url = new URL(`${normalizeFishAudioBaseUrl(params.baseUrl)}/model`);
  url.searchParams.set("type", "tts");
  url.searchParams.set("page_size", String(FISH_AUDIO_VOICE_PAGE_SIZE));
  url.searchParams.set("page_number", String(params.pageNumber));
  if (params.self) {
    url.searchParams.set("self", "true");
  } else {
    url.searchParams.set("sort_by", "score");
  }
  const { assertOkOrThrowProviderError, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: { headers: { Authorization: `Bearer ${params.apiKey}` } },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
    auditContext: "fish-audio.voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "Fish Audio voices API error");
    return await readProviderJsonResponse<FishAudioVoicePayload>(response, "Fish Audio voices", {
      maxBytes: FISH_AUDIO_VOICES_MAX_BYTES,
    });
  } finally {
    await release();
  }
}

export async function listFishAudioVoices(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<SpeechVoiceOption[]> {
  const own: SpeechVoiceOption[] = [];
  for (let pageNumber = 1; pageNumber <= FISH_AUDIO_MAX_OWN_VOICE_PAGES; pageNumber += 1) {
    const payload = await requestVoicePage({ ...params, self: true, pageNumber });
    const items = Array.isArray(payload.items) ? payload.items : [];
    own.push(...items.flatMap((item) => parseVoiceItem(item) ?? []));
    if (
      items.length < FISH_AUDIO_VOICE_PAGE_SIZE ||
      own.length >= (payload.total ?? Number.MAX_SAFE_INTEGER)
    ) {
      break;
    }
  }

  let publicVoices: SpeechVoiceOption[] = [];
  try {
    const payload = await requestVoicePage({ ...params, self: false, pageNumber: 1 });
    publicVoices = (Array.isArray(payload.items) ? payload.items : []).flatMap(
      (item) => parseVoiceItem(item) ?? [],
    );
  } catch {
    // Own voices remain useful when the public catalog is temporarily unavailable.
  }

  const seen = new Set<string>();
  return [...own, ...publicVoices].filter((voice) => {
    if (seen.has(voice.id)) {
      return false;
    }
    seen.add(voice.id);
    return true;
  });
}

export const FISH_AUDIO_STREAM_MAX_BYTES = MAX_AUDIO_BYTES;
