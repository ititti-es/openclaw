// Fish Audio tests cover config, request mapping, streaming, discovery, and target formats.
import { afterEach, describe, expect, it, vi } from "vitest";
import catalog from "./capability-catalog.js";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: releaseMock,
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected Fish Audio JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("Fish Audio speech provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchWithSsrFGuardMock.mockClear();
    releaseMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exposes the direct S2.1 default without requiring a voice id", () => {
    vi.stubEnv("FISH_API_KEY", "fish-test");
    const provider = buildFishAudioSpeechProvider();
    expect(provider.defaultModel).toBe("s2.1-pro");
    expect(provider.models).toEqual(["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1"]);
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 1_000 })).toBe(true);
  });

  it("maps hosted synthesis and preserves Fish expression tags", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.fish.audio/v1/tts");
      expect(new Headers(init?.headers).get("model")).toBe("s2.1-pro");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fish-test");
      expect(requestBody(init)).toEqual({
        text: "[whisper] Keep this quiet. [excited] Now celebrate!",
        format: "mp3",
        reference_id: "voice-123",
        sample_rate: 44100,
        latency: "normal",
        prosody: { speed: 1.1 },
        temperature: 0.6,
        top_p: 0.8,
        normalize: false,
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const result = await provider.synthesize({
      text: "[whisper] Keep this quiet. [excited] Now celebrate!",
      cfg: {} as never,
      providerConfig: {
        apiKey: "fish-test",
        model: "s2.1-pro",
        speakerVoiceId: "voice-123",
        latency: "normal",
        speed: 1.1,
        temperature: 0.6,
        topP: 0.8,
        normalize: false,
      },
      target: "audio-file",
      timeoutMs: 12_345,
    });
    expect(result).toMatchObject({
      audioBuffer: Buffer.from([1, 2, 3]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 12_345, auditContext: "fish-audio.tts" }),
    );
  });

  it("uses native Opus for streamed voice notes and releases the response", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(requestBody(init)).toMatchObject({ format: "opus", sample_rate: 48000 });
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "audio/opus" },
      });
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const result = await provider.streamSynthesize?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: { apiKey: "fish-test" },
      target: "voice-note",
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    const bytes = new Uint8Array(await new Response(result?.audioStream).arrayBuffer());
    expect([...bytes]).toEqual([4, 5, 6]);
    await result?.release?.();
  });

  it("requests raw 8 kHz PCM for telephony", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(requestBody(init)).toMatchObject({ format: "pcm", sample_rate: 8000 });
      return new Response(new Uint8Array([7, 8]));
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: { apiKey: "fish-test" },
      timeoutMs: 1_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from([7, 8]),
      outputFormat: "pcm",
      sampleRate: 8000,
    });
  });

  it("lists all owned pages then one public page with deduplication", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const self = parsed.searchParams.get("self") === "true";
      const page = Number(parsed.searchParams.get("page_number"));
      if (self && page === 1) {
        return Response.json({
          total: 101,
          items: Array.from({ length: 100 }, (_, index) => ({
            _id: `own-${index}`,
            title: `Own ${index}`,
          })),
        });
      }
      if (self) {
        return Response.json({ total: 101, items: [{ _id: "own-100", title: "Own 100" }] });
      }
      return Response.json({
        items: [
          { _id: "own-0", title: "Duplicate" },
          { _id: "public-1", title: "Public", languages: ["en"], tags: ["warm"] },
        ],
      });
    }) as unknown as typeof fetch;
    const provider = buildFishAudioSpeechProvider();
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "fish-test" },
      timeoutMs: 9_000,
    });
    expect(voices).toHaveLength(102);
    expect(voices?.at(-1)).toMatchObject({ id: "public-1", locale: "en", personalities: ["warm"] });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed on blank credentials before network access", async () => {
    vi.stubEnv("FISH_API_KEY", "   ");
    vi.stubEnv("FISH_AUDIO_API_KEY", "   ");
    const provider = buildFishAudioSpeechProvider();
    const providerConfig = { apiKey: "   " };
    expect(provider.isConfigured({ providerConfig, timeoutMs: 1_000 })).toBe(false);
    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {} as never,
        providerConfig,
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Fish Audio API key missing");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    { key: "temperature", value: "0", overrides: { temperature: 0 } },
    { key: "fish_temperature", value: "-0", overrides: { temperature: -0 } },
    { key: "top_p", value: "0", overrides: { topP: 0 } },
    { key: "topp", value: "1", overrides: { topP: 1 } },
    { key: "speed", value: "0.5", overrides: { speed: 0.5 } },
    { key: "fish_speed", value: "2", overrides: { speed: 2 } },
  ])("accepts the $key=$value directive boundary", ({ key, value, overrides }) => {
    const provider = buildFishAudioSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key,
        value,
        policy: {
          enabled: true,
          allowText: true,
          allowProvider: true,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        },
      }),
    ).toEqual({ handled: true, overrides });
  });
});

describe("OpenAI-compatible speech transport", () => {
  const provider = catalog.speechProviders[0];
  if (!provider) {
    throw new Error("Fish Audio speech catalog entry missing");
  }
  const originalFetch = globalThis.fetch;
  const providerConfig = {
    transport: "openai-compatible",
    baseURL: "https://speech.example.test",
    apiKey: "gateway-test",
    model: "fish-s2.1-pro-free",
  };
  const request = {
    text: "[whisper] Hello",
    cfg: {},
    providerConfig,
    target: "audio-file" as const,
    timeoutMs: 1234,
  };
  const policy = {
    enabled: true,
    allowText: true,
    allowProvider: true,
    allowVoice: true,
    allowModelId: true,
    allowVoiceSettings: true,
    allowNormalization: true,
    allowSeed: true,
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchWithSsrFGuardMock.mockClear();
    releaseMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves opt-in config and isolates environment credentials", async () => {
    vi.stubEnv("FISH_API_KEY", "fish-test");
    vi.stubEnv("FISH_AUDIO_API_KEY", "fish-compat-test");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
    const config = provider.resolveConfig?.({
      cfg: {},
      rawConfig: { providers: { "fish-audio": { ...providerConfig, apiKey: undefined } } },
      timeoutMs: 1000,
    });
    expect(config).toMatchObject({
      transport: "openai-compatible",
      baseUrl: "https://speech.example.test/v1",
      model: "fish-s2.1-pro-free",
    });
    expect(provider.isConfigured({ providerConfig: config ?? {}, timeoutMs: 1000 })).toBe(false);
    await expect(provider.synthesize({ ...request, providerConfig: config ?? {} })).rejects.toThrow(
      "OpenAI-compatible API key missing",
    );
    vi.stubEnv("FISH_API_KEY", "");
    vi.stubEnv("FISH_AUDIO_API_KEY", "");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "gateway-env-test");
    expect(provider.isConfigured({ providerConfig: config ?? {}, timeoutMs: 1000 })).toBe(true);
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 1000 })).toBe(false);
    await expect(provider.synthesize({ ...request, providerConfig: {} })).rejects.toThrow(
      "Fish Audio API key missing",
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://speech.example.test",
    "https://speech.example.test/",
    "https://speech.example.test/v1",
    "https://speech.example.test/v1///",
  ])("maps OpenAI speech through %s without a Fish model header", async (baseURL) => {
    vi.stubEnv("FISH_API_KEY", "fish-test");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "gateway-env-test");
    const input_references = [
      { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AQID", format: "wav" } },
      { type: "text", text: "Reference words" },
    ];
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://speech.example.test/v1/audio/speech");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer gateway-env-test");
      expect(headers.has("model")).toBe(false);
      expect(requestBody(init)).toEqual({
        model: "arbitrary-clone-alias",
        input: request.text,
        voice: "sage",
        response_format: "mp3",
        speed: 1.2,
        input_references,
      });
      return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } });
    });
    const result = await provider.synthesize({
      ...request,
      providerConfig: {
        transport: "openai-compatible",
        baseURL,
        model: "arbitrary-clone-alias",
        voice: "sage",
        speed: 1.2,
        input_references,
      },
    });
    expect(result.audioBuffer).toEqual(Buffer.from([1, 2]));
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1234,
        auditContext: "fish-audio.openai-compatible.tts",
      }),
    );
  });

  it("accepts aliases in Talk config, Talk overrides and directives but preserves direct model validation", () => {
    const baseTtsConfig = {
      providers: { "fish-audio": { ...providerConfig, model: "old-alias" } },
    };
    const talk = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig,
      talkProviderConfig: { modelId: "new-clone-alias" },
      timeoutMs: 1000,
    });
    expect(talk).toMatchObject({ transport: "openai-compatible", model: "new-clone-alias" });
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: talk ?? {},
        params: { modelId: "another-alias", voiceId: "sage" },
      }),
    ).toMatchObject({ model: "another-alias", voiceId: "sage" });
    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        value: "directive-alias",
        policy,
        providerConfig,
      }),
    ).toEqual({ handled: true, overrides: { model: "directive-alias" } });
    expect(
      provider.parseDirectiveToken?.({ key: "voice", value: "sage", policy, providerConfig }),
    ).toEqual({ handled: true, overrides: { voice: "sage" } });
    expect(
      provider.parseDirectiveToken?.({ key: "model", value: "directive-alias", policy }),
    ).toMatchObject({
      handled: true,
      warnings: [expect.stringContaining("invalid Fish Audio model")],
    });
  });

  it("resolves transport-neutral Talk overrides using the effective synthesis config", async () => {
    const overrides = provider.resolveTalkOverrides?.({
      talkProviderConfig: {},
      params: { modelId: " custom-alias ", voiceId: " alloy " },
    });
    expect(overrides).toMatchObject({ model: "custom-alias", voiceId: "alloy" });
    const inherited = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { "fish-audio": providerConfig } },
      talkProviderConfig: {},
      timeoutMs: 1000,
    });
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = requestBody(init);
      if (body.input !== undefined) {
        expect(body).toMatchObject({ model: "custom-alias", voice: "alloy" });
      } else {
        expect(body).toMatchObject({ reference_id: "alloy" });
        expect(new Headers(init?.headers).get("model")).toBe("s1");
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
    });
    await provider.synthesize({ ...request, providerOverrides: overrides });
    await provider.synthesize({
      ...request,
      providerConfig: inherited ?? {},
      providerOverrides: overrides,
    });
    const directConfig = { apiKey: "fish-test" };
    await expect(
      provider.synthesize({
        ...request,
        providerConfig: directConfig,
        providerOverrides: overrides,
      }),
    ).rejects.toThrow("invalid Fish Audio model");
    const directOverrides = provider.resolveTalkOverrides?.({
      talkProviderConfig: {},
      params: { modelId: "s1", voiceId: "alloy" },
    });
    await provider.synthesize({
      ...request,
      providerConfig: directConfig,
      providerOverrides: directOverrides,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it.each(["fish", "openai-compatible"])(
    "discards inherited transport-specific options when Talk switches to %s",
    async (transport) => {
      const from =
        transport === "fish"
          ? {
              ...providerConfig,
              model: "custom-alias",
              voice: "sage",
              speakerVoiceId: "inherited-speaker",
              voiceId: "inherited-voice",
              input_references: [{}],
              inputReferences: [{}],
              speed: 1.5,
            }
          : {
              apiKey: "fish-test",
              baseUrl: "https://fish.example.test",
              baseURL: "https://fish.example.test",
              model: "s1",
              modelId: "s1",
              voice: "inherited-voice",
              speakerVoiceId: "inherited-speaker",
              voiceId: "inherited-id",
              referenceId: "fish-reference",
              reference_id: "fish-reference",
              latency: "low",
              temperature: 0.3,
              topP: 0.6,
              top_p: 0.6,
              normalize: false,
              speed: 1.5,
              sampleRate: 8000,
              sample_rate: 8000,
            };
      const talk = provider.resolveTalkConfig?.({
        cfg: {},
        baseTtsConfig: { providers: { "fish-audio": from } },
        talkProviderConfig: {
          transport,
          ...(transport === "openai-compatible"
            ? { baseURL: "https://speech.example.test", model: "fish-s2.1-pro-free" }
            : {}),
        },
        timeoutMs: 1000,
      });
      expect(talk?.apiKey).toBeUndefined();
      expect(talk?.baseUrl).toBe(
        transport === "fish" ? "https://api.fish.audio" : "https://speech.example.test/v1",
      );
      vi.stubEnv(
        transport === "fish" ? "FISH_API_KEY" : "OPENAI_COMPATIBLE_API_KEY",
        "selected-test",
      );
      globalThis.fetch = vi.fn(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer selected-test");
        expect(requestBody(init)).toEqual(
          transport === "fish"
            ? { text: request.text, format: "mp3", sample_rate: 44100, latency: "balanced" }
            : {
                model: "fish-s2.1-pro-free",
                input: request.text,
                voice: "alloy",
                response_format: "mp3",
              },
        );
        return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
      });
      await provider.synthesize({ ...request, providerConfig: talk ?? {} });
      expect(() =>
        provider.resolveTalkConfig?.({
          cfg: {},
          baseTtsConfig: { providers: { "fish-audio": from } },
          talkProviderConfig: {
            transport,
            ...(transport === "openai-compatible"
              ? { baseURL: "https://speech.example.test", latency: "low" }
              : { input_references: [{}] }),
          },
          timeoutMs: 1000,
        }),
      ).toThrow(
        transport === "openai-compatible"
          ? "does not support Fish Audio latency"
          : "requires OpenAI-compatible transport",
      );
    },
  );

  it.each(["referenceId", "latency", "temperature", "topP", "normalize", "sampleRate"])(
    "rejects Fish-only %s in config and overrides before network access",
    async (key) => {
      await expect(
        provider.synthesize({
          ...request,
          providerConfig: { ...providerConfig, [key]: key === "referenceId" ? "fish-voice" : 1 },
        }),
      ).rejects.toThrow(`does not support Fish Audio ${key}`);
      await expect(
        provider.synthesize({ ...request, providerOverrides: { [key]: 1 } }),
      ).rejects.toThrow(`does not support Fish Audio ${key}`);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("requires an endpoint and model and rejects telephony across buffered and streamed entry points", async () => {
    expect(() =>
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: { providers: { "fish-audio": { transport: "openai-compatible" } } },
        timeoutMs: 1000,
      }),
    ).toThrow("requires baseUrl");
    expect(() =>
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: {
          providers: {
            "fish-audio": {
              transport: "openai-compatible",
              baseURL: "https://speech.example.test",
            },
          },
        },
        timeoutMs: 1000,
      }),
    ).toThrow("OpenAI-compatible transport requires model");
    await expect(provider.synthesizeTelephony?.(request)).rejects.toThrow(
      "does not support telephony",
    );
    await expect(provider.synthesize({ ...request, target: "telephony" })).rejects.toThrow(
      "does not support telephony",
    );
    await expect(provider.streamSynthesize?.({ ...request, target: "telephony" })).rejects.toThrow(
      "does not support telephony",
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("returns only configured voices or an unsupported discovery error without network access", async () => {
    expect(
      await provider.listVoices?.({ providerConfig: { ...providerConfig, voice: "sage" } }),
    ).toEqual([{ id: "sage" }]);
    await expect(provider.listVoices?.({ providerConfig })).rejects.toThrow(
      "voice discovery is unsupported",
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("bounds buffered audio and rejects reference parts in direct mode", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-test");
      expect(requestBody(init)).toMatchObject({ model: "fish-s2.1-pro-free", voice: "alloy" });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    await expect(
      provider.synthesize({
        ...request,
        cfg: { agents: { defaults: { mediaMaxMb: 2 / (1024 * 1024) } } },
      }),
    ).rejects.toThrow("exceeds");
    expect(releaseMock).toHaveBeenCalledTimes(1);
    await expect(
      provider.synthesize({
        ...request,
        providerConfig: { apiKey: "fish-test", input_references: [{}] },
      }),
    ).rejects.toThrow("requires OpenAI-compatible transport");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it.each(["complete", "cancel", "release", "overflow"])(
    "cleans up bounded streaming on %s",
    async (mode) => {
      const cancel = vi.fn();
      globalThis.fetch = vi.fn(async (_url, init) => {
        expect(requestBody(init)).toMatchObject({ response_format: "opus", voice: "alloy" });
        expect(requestBody(init)).not.toHaveProperty("sample_rate");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              if (mode === "complete") {
                controller.close();
              }
            },
            cancel,
          }),
          { headers: { "content-type": "audio/opus" } },
        );
      });
      const result = await provider.streamSynthesize?.({
        ...request,
        target: "voice-note",
        cfg: {
          agents: { defaults: { mediaMaxMb: (mode === "overflow" ? 2 : 10) / (1024 * 1024) } },
        },
      });
      expect(result).toMatchObject({ outputFormat: "opus", voiceCompatible: true });
      if (!result) {
        throw new Error("stream missing");
      }
      if (mode === "complete") {
        expect(await new Response(result.audioStream).arrayBuffer()).toEqual(
          new Uint8Array([1, 2, 3]).buffer,
        );
      } else if (mode === "cancel") {
        await result.audioStream.cancel();
      } else if (mode === "overflow") {
        await expect(new Response(result.audioStream).arrayBuffer()).rejects.toThrow(
          "exceeds 2 bytes",
        );
      }
      await result.release?.();
      await result.release?.();
      expect(releaseMock).toHaveBeenCalledTimes(1);
      if (mode !== "complete") {
        expect(cancel).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["http", "json", "read"])("releases streaming responses on %s failure", async (mode) => {
    globalThis.fetch = vi.fn(async () =>
      mode === "http"
        ? new Response("upstream failed", { status: 502 })
        : mode === "json"
          ? Response.json({ error: "not audio" })
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("broken stream"));
                },
              }),
              { headers: { "content-type": "audio/mpeg" } },
            ),
    );
    if (mode === "read") {
      const result = await provider.streamSynthesize?.(request);
      await expect(new Response(result?.audioStream).arrayBuffer()).rejects.toThrow(
        "broken stream",
      );
      await result?.release?.();
    } else {
      await expect(provider.streamSynthesize?.(request)).rejects.toThrow("OpenAI-compatible TTS");
    }
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
