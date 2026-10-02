// Tells a model gateway running on this machine which agent and harness a request comes from,
// so a gateway that stores conversations (such as a LiteLLM session store) can label them.
// Only loopback endpoints get these headers: an agent's name never leaves the host.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveProviderRequestPolicy } from "../../../agents/provider-attribution.js";
import { getModelProviderRequestRouteFacts } from "../../../agents/provider-request-config.js";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";

export const OPENCLAW_AGENT_ID_HEADER = "x-openclaw-agent-id";
export const LITELLM_HARNESS_HEADER = "x-litellm-harness";
const HARNESS = "openclaw";

function isLocalEndpoint(model: Parameters<StreamFn>[0]): boolean {
  const endpointClass =
    getModelProviderRequestRouteFacts(model)?.capabilities.endpointClass ??
    resolveProviderRequestPolicy({
      provider: readStringValue(model.provider),
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
    }).endpointClass;
  return endpointClass === "local";
}

export function createLocalEndpointIdentityHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  agentId: string | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isLocalEndpoint(model)) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: {
        [LITELLM_HARNESS_HEADER]: HARNESS,
        ...(agentId ? { [OPENCLAW_AGENT_ID_HEADER]: agentId } : {}),
        ...options?.headers,
      },
    });
  };
}
