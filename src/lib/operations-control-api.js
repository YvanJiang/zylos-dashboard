import { OperationsAuthError } from './operations-auth-adapter.js';
import { OperationsControlError } from './operations-control-client.js';

function errorResponse(error) {
  if (error instanceof OperationsAuthError || error instanceof OperationsControlError) {
    return { status: error.status || 400, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: 'internal_error', message: 'Operations control failed.' } };
}

export function createOperationsControlApi({
  authorizationAdapter,
  client,
  resultStore,
  getVerifiedSubject,
  readJsonBody,
  sendJson,
} = {}) {
  return {
    async handle(req, res, url) {
      const match = url.pathname.match(/^\/api\/runtime-controls\/([^/]+)$/);
      const isCollection = url.pathname === '/api/runtime-controls';
      if (!isCollection && !match) return false;

      const subject = getVerifiedSubject(req);
      if (!subject) {
        sendJson(res, 401, { error: 'unauthenticated' });
        return true;
      }

      if (isCollection && req.method === 'POST') {
        let input;
        try {
          input = await readJsonBody(req, 32 * 1024);
          const request = authorizationAdapter.createRequest(subject, input);
          const result = await client.submit(request);
          const update = resultStore.apply(result, { action: request.action });
          sendJson(res, result.status === 'accepted' ? 202 : 200, {
            result: update.result,
            result_update: { status: update.status, apply: update.apply },
          });
        } catch (error) {
          const response = errorResponse(error);
          sendJson(res, response.status, response.body);
        }
        return true;
      }

      if (match && req.method === 'GET') {
        const controlId = decodeURIComponent(match[1]);
        try {
          const result = await client.getResult(authorizationAdapter.callerNamespace, controlId);
          const update = resultStore.apply(result);
          sendJson(res, 200, {
            result: update.result,
            result_update: { status: update.status, apply: update.apply },
          });
        } catch (error) {
          const response = errorResponse(error);
          sendJson(res, response.status, response.body);
        }
        return true;
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    },
  };
}
