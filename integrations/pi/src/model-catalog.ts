import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { APPLICATION_MODELS_PATH } from './bigmodel.ts';

// Trusted application data in Pi's own static configuration format. Never load this from
// the repository under review; Pi continues to own all protocol adaptation.
export const CATALOG_REVISION = "pi-0.84.1+mergewarden-20260928";
export function modelCatalogOptions() {
  // Pi registerProvider starts an unawaited refresh of ALL providers, even with
  // refreshOnCreate:false. Load trusted static data at creation instead, keeping
  // auth probes and credential I/O limited to explicit, awaited operations.
  return { modelsPath: APPLICATION_MODELS_PATH, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false };
}
