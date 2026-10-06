# Fish Audio speech plugin

Official OpenClaw speech provider for Fish Audio's hosted S2.1 API.
An opt-in transport routes speech through any OpenAI-compatible gateway.

Install it with:

```bash
openclaw plugins install @openclaw/fish-audio-speech
```

The plugin id is `fish-audio-speech`; the speech provider and TTS config id
remain `fish-audio`. Configure `tts.provider: "fish-audio"` and set
`FISH_API_KEY`. The provider supports buffered audio, HTTP-streamed playback,
native Opus voice notes, 8 kHz PCM telephony, and Fish Audio voice discovery.

## OpenAI-compatible transport

Set `tts.providers.fish-audio.transport` to `"openai-compatible"` to send
speech to any OpenAI-compatible `/v1/audio/speech` endpoint (for example a
LiteLLM or OpenRouter-style gateway that serves Fish models), and configure the
endpoint explicitly. Omitted transport (or `"fish"`) preserves direct Fish
requests, model validation, and credentials.

```json5
{
  tts: {
    provider: "fish-audio",
    providers: {
      "fish-audio": {
        transport: "openai-compatible",
        baseURL: "https://speech.example.com/v1",
        apiKey: "${OPENAI_COMPATIBLE_API_KEY}",
        model: "fish-s2.1-pro-free",
        voice: "alloy",
      },
    },
  },
}
```

`baseUrl` and `baseURL` accept a gateway root or an endpoint ending in `/v1`;
the plugin adds `/v1` only when needed and posts to `/v1/audio/speech`.
An explicit `apiKey` takes precedence over `OPENAI_COMPATIBLE_API_KEY`. This
transport never falls back to `FISH_API_KEY` or `FISH_AUDIO_API_KEY`, and direct
Fish never uses `OPENAI_COMPATIBLE_API_KEY`. When Talk changes transport, all
inherited provider options are cleared, including credentials, endpoints,
models, voices, references, and tuning. Supply the endpoint, credentials, and
any desired options for that mode.

The OpenAI-compatible transport accepts any model name or gateway alias in
config, Talk, and directives. Set `model` to whatever your gateway serves; when
omitted it defaults to `fish-s2.1-pro-free`. The static capability catalog still
lists direct Fish models and the direct default `s2.1-pro`.

Requests contain `model`, `input`, `voice`, `response_format`, and optional
`speed`. `voice` defaults to `alloy`; `speakerVoiceId` and `voiceId` are also
accepted as OpenAI voice names in this mode. These are not Fish saved voice ids.
For cloning, prefer a model alias bound to a reference clip on the gateway, or
configure `input_references` (also accepted as `inputReferences`) as a nonempty
array of OpenRouter-style reference parts:

```json5
input_references: [
  { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AQID", format: "wav" } },
  { type: "text", text: "The exact words in the reference audio." },
]
```

The plugin forwards reference parts as-is, without converting a Fish
`referenceId` or reading local files; how they combine with clips bound on the
gateway is up to the gateway. `referenceId`, `latency`, `temperature`,
`topP`/`top_p`, `normalize`, and sample-rate tuning are Fish-only and fail before
network access in this mode, including per-call overrides and directives
applied during synthesis.

The OpenAI-compatible transport supports MP3 audio files and Opus voice notes,
with the existing guarded, byte-bounded HTTP streaming path. Stream consumers
must await `release()` in their cleanup, including on read errors. Telephony
fails explicitly because the gateway's PCM is not guaranteed to be 8 kHz. Voice
discovery returns the configured voice or an unsupported error; it never calls
Fish `/model` on the gateway.

See [Fish Audio](https://docs.openclaw.ai/providers/fish-audio) for setup,
models, voice selection, expressive tags, and local macOS MLX usage.
