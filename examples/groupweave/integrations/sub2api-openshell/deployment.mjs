// Mount the private JSON configuration read-only; never commit its credentials.
import { loadDeployment } from './binding.mjs';
export default await loadDeployment(process.env.GROUPWEAVE_MODEL_CONFIG);
