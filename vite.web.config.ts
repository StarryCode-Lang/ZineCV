import { mergeConfig } from "vite";
import desktop from "./vite.config.ts";
export default mergeConfig(desktop, { worker: { format: "es" }, build: { rolldownOptions: { input: "web.html" } } });
