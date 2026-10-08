// Fish Audio plugin entrypoint registers hosted speech synthesis.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "fish-audio-speech",
  name: "Fish Audio Speech",
  description: "Fish Audio speech provider with opt-in OpenAI-compatible transport",
  register(api) {
    api.registerSpeechProvider(buildFishAudioSpeechProvider());
  },
});
