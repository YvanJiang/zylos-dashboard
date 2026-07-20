import crypto from 'node:crypto';
import {
  containsPublicSecretValue,
  isValidRfc3339Timestamp,
  OPERATIONS_ACTION_DEFINITIONS,
  OPERATIONS_TARGET_IDENTITIES,
} from '../../public/js/operations-control-contract.js';

const CLIENT_AUTHORITY_FIELDS = new Set([
  'actor', 'auth_context', 'role', 'roles', 'capability', 'capabilities', 'scope',
  'policy_id', 'policy_version', 'grant_id', 'expires_at',
]);

const ACTION_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(OPERATIONS_ACTION_DEFINITIONS).map(([action, definition]) => [action, definition.capability]),
));

const SCOPE_PRIORITY = Object.freeze({ tenant: 0, bot: 1, service: 2, conversation: 2, recovery: 3 });
const INPUT_FIELDS = new Set(['control_id', 'action', 'target', 'expected_version', 'reason']);

export class OperationsAuthError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'OperationsAuthError';
    this.code = code;
    this.status = status;
  }
}

function controlIdempotencyKey(callerNamespace, controlId) {
  const input = JSON.stringify([
    'zylos-idempotency-v1',
    'control',
    callerNamespace,
    controlId,
  ]);
  const digest = crypto.createHash('sha256').update(input).digest('hex');
  return `zid:v1:control:${digest}`;
}

function rejectClientAuthority(input) {
  const field = Object.keys(input || {}).find((name) => CLIENT_AUTHORITY_FIELDS.has(name));
  if (field) {
    throw new OperationsAuthError(
      'client_authority_forbidden',
      `The browser must not supply operations authority field ${field}.`,
      400,
    );
  }
}

function invalidRequest(message) {
  throw new OperationsAuthError('invalid_control_request', message, 400);
}

function invalidPolicy(message) {
  throw new OperationsAuthError('invalid_policy', message, 503);
}

function validateScope(scope) {
  const fields = ['scope_type', 'region', 'tenant_id', 'bot_id', 'conversation_id', 'service_instance_id', 'recovery_id'];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).length !== fields.length || !fields.every((field) => Object.hasOwn(scope, field))) {
    invalidPolicy('Every operations grant scope must use the exact Core v1 shape.');
  }
  if (!['tenant', 'bot', 'conversation', 'service', 'recovery'].includes(scope.scope_type)) invalidPolicy('Grant scope_type is unsupported.');
  for (const field of ['region', 'tenant_id']) {
    if (typeof scope[field] !== 'string' || scope[field].length === 0) invalidPolicy(`Grant ${field} is required.`);
  }
  const required = {
    bot_id: ['bot', 'conversation', 'recovery'].includes(scope.scope_type),
    conversation_id: ['conversation', 'recovery'].includes(scope.scope_type),
    service_instance_id: scope.scope_type === 'service',
    recovery_id: scope.scope_type === 'recovery',
  };
  for (const [field, isRequired] of Object.entries(required)) {
    if (isRequired ? (typeof scope[field] !== 'string' || scope[field].length === 0) : scope[field] !== null) {
      invalidPolicy(`Grant ${field} does not match ${scope.scope_type} scope.`);
    }
  }
}

function validatePolicy(callerNamespace, policy) {
  if (typeof callerNamespace !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(callerNamespace)) {
    invalidPolicy('callerNamespace must match the Core caller namespace contract.');
  }
  if (!policy || typeof policy.policy_id !== 'string' || policy.policy_id.length === 0
    || !Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1
    || !Array.isArray(policy.grants)) {
    invalidPolicy('A versioned deployment authorization policy is required.');
  }
  for (const grant of policy.grants) {
    if (!grant || typeof grant.grant_id !== 'string' || grant.grant_id.length === 0
      || !['user', 'service'].includes(grant.subject?.type)
      || typeof grant.subject?.subject_id !== 'string' || grant.subject.subject_id.length === 0
      || !Object.values(ACTION_CAPABILITIES).includes(grant.capability)
      || !Number.isSafeInteger(grant.policy_version) || grant.policy_version < 1) {
      invalidPolicy('Every deployment grant must identify its subject, capability, and policy version.');
    }
    validateScope(grant.scope);
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidRequest('Request body must be an object.');
  const unknown = Object.keys(input).find((field) => !INPUT_FIELDS.has(field));
  if (unknown) invalidRequest(`Unknown operations request field ${unknown}.`);
  const definition = OPERATIONS_ACTION_DEFINITIONS[input.action];
  const targetFields = definition?.targets?.[input.target?.aggregate_type];
  if (!targetFields) invalidRequest('Action and target aggregate type do not match Core v1.');
  const exactFields = ['aggregate_type', ...targetFields];
  if (Object.keys(input.target).length !== exactFields.length
    || !exactFields.every((field) => Object.hasOwn(input.target, field))) {
    invalidRequest('Target does not match the exact Core v1 action shape.');
  }
  for (const field of targetFields) {
    const value = input.target[field];
    if (field === 'through_queue_sequence') {
      if (!Number.isSafeInteger(value) || value < 1) invalidRequest('Queue sequence must be positive.');
    } else if (typeof value !== 'string' || value.length === 0) {
      invalidRequest(`Target ${field} must be a non-empty Core ID.`);
    }
  }
  const identity = input.target[OPERATIONS_TARGET_IDENTITIES[input.target.aggregate_type]];
  if (input.expected_version === null) {
    if (definition.mutable) invalidRequest('Every mutation requires expected_version.');
  } else {
    const expected = input.expected_version;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || Object.keys(expected).length !== 3
      || expected.aggregate_type !== input.target.aggregate_type
      || expected.aggregate_id !== identity
      || !Number.isSafeInteger(expected.version) || expected.version < 1) {
      invalidRequest('expected_version must identify the canonical target aggregate and version.');
    }
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || containsPublicSecretValue(input.reason)) {
    invalidRequest('A non-secret redacted reason is required.');
  }
}

function scopeCouldCover(scope, target) {
  switch (scope?.scope_type) {
    case 'tenant':
      return true;
    case 'bot':
      return target.aggregate_type !== 'service';
    case 'conversation':
      return target.conversation_id === scope.conversation_id;
    case 'service':
      return target.aggregate_type === 'service'
        && target.service_instance_id === scope.service_instance_id;
    case 'recovery':
      return target.aggregate_type === 'recovery'
        && target.recovery_id === scope.recovery_id
        && (!Object.hasOwn(target, 'conversation_id')
          || target.conversation_id === scope.conversation_id);
    default:
      return false;
  }
}

function breakGlassAudited(grant) {
  if (!grant.break_glass) return true;
  return typeof grant.expires_at === 'string'
    && grant.expires_at.length > 0
    && typeof grant.break_glass_reason === 'string'
    && grant.break_glass_reason.length > 0
    && typeof grant.approved_by === 'string'
    && grant.approved_by.length > 0
    && typeof grant.security_audit_id === 'string'
    && grant.security_audit_id.length > 0;
}

function activeGrant(policy, subject, action, target, now) {
  if (policy?.state !== 'active') return null;
  const capability = ACTION_CAPABILITIES[action];
  if (!capability) return null;
  const candidates = policy.grants?.filter((grant) => (
    grant.state === 'active'
    && grant.policy_version === policy.policy_version
    && grant.subject?.type === subject.type
    && grant.subject?.subject_id === subject.subject_id
    && grant.capability === capability
    && (!grant.required_role || subject.roles.includes(grant.required_role))
    && (grant.expires_at === null
      || (isValidRfc3339Timestamp(grant.expires_at) && Date.parse(grant.expires_at) > Date.parse(now)))
    && breakGlassAudited(grant)
    && scopeCouldCover(grant.scope, target)
  )) || [];
  return candidates.sort((left, right) => (
    (SCOPE_PRIORITY[right.scope.scope_type] ?? -1) - (SCOPE_PRIORITY[left.scope.scope_type] ?? -1)
  ))[0] || null;
}

function validateVerifiedSubject(subject) {
  if (!subject || !['user', 'service'].includes(subject.type)
    || !['dashboard_session', 'service_credential', 'platform_admin_bridge'].includes(subject.source)
    || typeof subject.subject_id !== 'string' || subject.subject_id.length === 0
    || !Array.isArray(subject.roles)
    || subject.roles.some((role) => typeof role !== 'string' || role.length === 0)
    || !isValidRfc3339Timestamp(subject.authenticated_at)) {
    throw new OperationsAuthError('unauthenticated', 'A verified external subject is required.', 401);
  }
}

function requireActiveGrant(policy, subject, action, target, now) {
  validateVerifiedSubject(subject);
  const grant = activeGrant(policy, subject, action, target, now);
  if (!grant) {
    throw new OperationsAuthError('forbidden', 'The verified subject has no current covering operations grant.');
  }
  return grant;
}

export class OperationsAuthorizationAdapter {
  constructor({ callerNamespace, policy, now = () => new Date().toISOString(), generateId } = {}) {
    validatePolicy(callerNamespace, policy);
    this.callerNamespace = callerNamespace;
    this.policy = structuredClone(policy);
    this.now = now;
    this.generateId = generateId || ((kind) => `${kind}-${crypto.randomUUID()}`);
  }

  authorize(verifiedSubject, { action, target }) {
    const grant = requireActiveGrant(this.policy, verifiedSubject, action, target, this.now());
    return structuredClone(grant);
  }

  createRequest(verifiedSubject, input) {
    rejectClientAuthority(input);
    validateInput(input);
    const now = this.now();
    const grant = requireActiveGrant(this.policy, verifiedSubject, input.action, input.target, now);
    const controlId = input.control_id || this.generateId('control');
    return {
      contract: 'zylos.control-request',
      contract_version: '1.0',
      trace_id: this.generateId('trace'),
      caller_namespace: this.callerNamespace,
      control_id: controlId,
      action: input.action,
      target: structuredClone(input.target),
      expected_version: structuredClone(input.expected_version),
      actor: {
        type: verifiedSubject.type,
        actor_id: verifiedSubject.subject_id,
        authenticated: true,
        roles: [...verifiedSubject.roles],
        capabilities: [{
          capability: grant.capability,
          scope: structuredClone(grant.scope),
          policy_id: this.policy.policy_id,
          policy_version: this.policy.policy_version,
          grant_id: grant.grant_id,
          expires_at: grant.expires_at,
        }],
      },
      auth_context: {
        source: verifiedSubject.source,
        auth_subject_id: verifiedSubject.subject_id,
        tenant_id: grant.scope.tenant_id,
        bot_id: grant.scope.bot_id,
        authorization_policy_id: this.policy.policy_id,
        authorization_policy_version: this.policy.policy_version,
        authenticated_at: verifiedSubject.authenticated_at,
      },
      reason: input.reason,
      idempotency_key: controlIdempotencyKey(this.callerNamespace, controlId),
      created_at: now,
    };
  }
}
