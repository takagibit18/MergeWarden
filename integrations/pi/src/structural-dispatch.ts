import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchBridge, DispatchTrigger } from "../../../src/engine/dispatch-contracts.ts";
import { DISPATCH_MESSAGE, packageText } from "../../../src/engine/dispatch-service.ts";
import type { ProgressiveInvestigation } from '../../../src/engine/investigation-service.ts';
import { INVESTIGATION_MESSAGE } from '../../../src/engine/investigation-contracts.ts';

/** Transport only. All anchor, retrieval, evidence and budget work belongs to the host. */
export function dispatchAdapter(pi: ExtensionAPI, bridge: DispatchBridge | ProgressiveInvestigation) {
  pi.on("before_provider_request", event => { bridge.providerPayload(event.payload); });
  return async (trigger: DispatchTrigger) => {
    const pack = await bridge.dispatch(trigger);
    if (!pack || pack.terminal === "cancelled") return;
    if (pack.version === 'structural-dispatch-2') (bridge as ProgressiveInvestigation).queued(pack);
    else (bridge as DispatchBridge).queued(pack);
    pi.sendMessage({ customType: pack.version === 'structural-dispatch-2' ? INVESTIGATION_MESSAGE : DISPATCH_MESSAGE,
      content: pack.version === 'structural-dispatch-2' ? JSON.stringify(pack) : packageText(pack), display: true }, { deliverAs: "steer" });
    return pack;
  };
}
