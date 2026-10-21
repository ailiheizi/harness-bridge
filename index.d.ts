export type NativeOperation = 'create' | 'get' | 'list' | 'upload' | 'exec' | 'stop' | 'delete';
export type ExecutionEvidence = 'verified' | 'unverified' | 'not-run';
export type CleanupStatus = 'verified' | 'unverified' | 'not-created';

export interface TrustedTaskRequest {
  /** App-created task identity. Never derived from prompt text. */
  taskId: string;
  /** Authenticated app context, not an Agent-supplied claim. */
  tenantId: string;
  actorId: string;
  prompt: string;
  /** Optional app-owned `<skill-name>/SKILL.md`; uploaded in the standard skill directory layout. */
  skillPath?: string;
  /** Opaque app-owned reference passed only to authorization callbacks. Its contents are not snapshotted; callbacks must recheck current permissions. */
  binding?: unknown;
}

export interface NativeSandboxIdentity {
  id: string;
  name: string;
  workspace: string;
}

export interface BridgeEvidence {
  execution: ExecutionEvidence;
  cleanup: CleanupStatus;
  /** Exact model request count is not exposed by the native DSH stream. */
  modelRequestCount: null;
  dshSessionId?: string;
  toolCallCount?: number;
  nativeExitCode?: number;
}

export interface BridgeSuccess {
  taskId: string;
  status: 'completed';
  output: string;
  sandbox: NativeSandboxIdentity;
  cleanup: { status: 'verified' };
  evidence: BridgeEvidence & { execution: 'verified'; cleanup: 'verified'; dshSessionId: string; nativeExitCode: 0 };
}

export interface BridgeFailure {
  taskId: string;
  status: 'failed' | 'blocked';
  failure: { stage: string; code: string };
  sandbox?: NativeSandboxIdentity;
  cleanup: { status: Exclude<CleanupStatus, 'not-created'> } | { status: 'not-created' };
  evidence: BridgeEvidence;
}

export type BridgeResult = BridgeSuccess | BridgeFailure;

export interface AdmissionContext {
  request: TrustedTaskRequest;
  providerNames: readonly string[];
}

export interface NativeCallContext {
  operation: NativeOperation;
  taskId: string;
  tenantId: string;
  actorId: string;
  sandbox?: NativeSandboxIdentity;
}

export interface ResultAuthorizationContext {
  request: TrustedTaskRequest;
  result: BridgeResult;
}

export interface HarnessBridgeOptions {
  native: {
    cliPath: string;
    /** OpenShell logical workspace name (for example `default`), not a filesystem path. */
    workspace: string;
    image: string;
    policyPath: string;
    /** Private CLI home/config roots prepared by the trusted host. */
    home: string;
    xdgConfigHome: string;
    /** Optional non-secret direct gateway URL; never inferred from prompt. */
    gatewayEndpoint?: string;
    /** Existing OpenShell provider names; values/credentials remain native-side. */
    providers?: readonly string[];
  };
  dsh: {
    /** App-owned patch for the pinned DSH headless profile. */
    patchPath: string;
    /** Remote directory the patch exposes to the native DSH skill loader. */
    skillRoot?: string;
  };
  limits?: {
    totalTimeoutMs?: number;
    commandTimeoutMs?: number;
    maxOutputBytes?: number;
  };
  authorizeAdmission(context: AdmissionContext): void | Promise<void>;
  /** Called before every business-phase native operation, including identity reads; owned cleanup get/list/stop/delete uses controller authority and identity checks. */
  authorizeNativeCall(context: NativeCallContext): void | Promise<void>;
  /** Called before any result text is released to the application. */
  authorizeResult(context: ResultAuthorizationContext): void | Promise<void>;
}

export interface HarnessBridge {
  execute(request: TrustedTaskRequest, signal?: AbortSignal): Promise<BridgeResult>;
}

export declare function createHarnessBridge(options: HarnessBridgeOptions): HarnessBridge;
