import { fileURLToPath } from 'node:url';
/** Mainland standard API, not Coding Plan. Native Pi metadata only.
 * Published capabilities: https://docs.z.ai/guides/vlm/glm-5.3-flash
 * Effort levels: https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/README.md
 * Request limits chosen by a review belong in model-policy.ts, not this catalog.
 * Zero costs in models.json are required SDK placeholders, not quoted prices.
 */
export const APPLICATION_MODELS_PATH = fileURLToPath(new URL('./models.json', import.meta.url));
