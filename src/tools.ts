import { createToolsContext } from "./context/create-tools-context.js";
import registerTools from "./tools/register-tools.js";

export default function (api: any) {
  const ctx = createToolsContext(api);
  registerTools(api, ctx);
}
