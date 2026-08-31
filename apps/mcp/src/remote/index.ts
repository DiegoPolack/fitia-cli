import { createRemoteApp, type RemoteEnv } from "./app.ts";

export default {
  async fetch(request: Request, env: RemoteEnv): Promise<Response> {
    return await createRemoteApp(env).fetch(request, env);
  },
};
