import { authplaneProvider, McpServer } from "skybridge/server";
import { env } from "./env.js";

const server = new McpServer(
  { name: "pr-radar", version: "0.1.0" },
  { capabilities: {} },
  {
    oauth: await authplaneProvider<{ email?: string }>({
      issuer: env.AUTHPLANE_ISSUER,
      resource: env.SERVER_URL,
    }),
  },
).registerTool(
  {
    name: "radar-ping",
    description:
      "Verify the signed-in identity for PR Radar. Returns who you are according to the authorization server.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
    auth: { scopes: ["radar:read"] },
    view: { component: "radar-ping", description: "Signed-in identity card" },
  },
  (_input, extra) => {
    const subject = extra.authInfo?.extra?.subject;
    const email = extra.authInfo?.extra?.email;
    const scopes = extra.authInfo?.scopes ?? [];
    const clientId = extra.authInfo?.clientId;
    return {
      structuredContent: { subject, email, scopes, clientId, verifiedAt: new Date().toISOString() },
      content: [{ type: "text" as const, text: `Signed in as ${email ?? subject ?? "unknown"}` }],
      isError: false,
    };
  },
);

export default await server.run();
export type AppType = typeof server;
