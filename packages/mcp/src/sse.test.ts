import { expect, test } from "bun:test";
import { readSSE } from "./sse";

test("readSSE parses deploy metadata and the following run events across chunks", async () => {
  const chunks = [
    'event: deploy\ndata: {"action":"created","project_id":10,',
    '"project_name":"app","env_keys":["NODE_ENV"],"run":true,',
    '"env_changes_pending_restart":false}\n\nevent: log\ndata: "pull complete\\n"\n\n',
    'event: structured-error\ndata: {"code":"source_credential_required",',
    '"message":"credential required"}\n\nevent: error\ndata: "clone failed"\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const result = await readSSE(new Response(stream));

  expect(result).toEqual({
    logs: "pull complete\n",
    error: "clone failed",
    structuredError: {
      code: "source_credential_required",
      message: "credential required",
    },
    deploy: {
      action: "created",
      project_id: 10,
      project_name: "app",
      env_keys: ["NODE_ENV"],
      run: true,
      env_changes_pending_restart: false,
    },
  });
});
