/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable, EventEmitter } from '../../common/events';
import CdpConnection from '../../cdp/connection';
import * as launcher from './launcher';
import * as nls from 'vscode-nls';
import { BrowserTargetManager } from './browserTargets';
import { ITarget, ILauncher, ILaunchResult, ILaunchContext, IStopMetadata } from '../targets';
import { AnyLaunchConfiguration, AnyChromiumAttachConfiguration } from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { createTargetFilterForConfig } from '../../common/urlUtils';
import { delay } from '../../common/promiseUtil';
import { CancellationToken } from 'vscode';
import { NeverCancelled } from '../../common/cancellation';
import { ILogger } from '../../common/logging';
import { injectable, inject } from 'inversify';
import { ISourcePathResolver } from '../../common/sourcePathResolver';

const localize = nls.loadMessageBundle();

@injectable()
export class BrowserAttacher implements ILauncher {
  private _attemptTimer: NodeJS.Timer | undefined;
  private _connection: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _disposables: IDisposable[] = [];
  private _lastLaunchParams?: AnyChromiumAttachConfiguration;
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourcePathResolver) private readonly pathResolver: ISourcePathResolver,
  ) {}

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
    if (this._attemptTimer) clearTimeout(this._attemptTimer);
    if (this._targetManager) this._targetManager.dispose();
  }

  async launch(params: AnyLaunchConfiguration, context: ILaunchContext): Promise<ILaunchResult> {
    if (
      (params.type !== DebugType.Chrome && params.type !== DebugType.Edge) ||
      params.request !== 'attach'
    ) {
      return { blockSessionTermination: false };
    }

    this._lastLaunchParams = params;

    const error = await this._attemptToAttach(params, context);
    return error ? { error } : { blockSessionTermination: true };
  }

  _scheduleAttach(params: AnyChromiumAttachConfiguration, context: ILaunchContext) {
    this._attemptTimer = setTimeout(() => {
      this._attemptTimer = undefined;
      this._attemptToAttach(params, { ...context, cancellationToken: NeverCancelled });
    }, 1000);
  }

  async _attemptToAttach(params: AnyChromiumAttachConfiguration, context: ILaunchContext) {
    const connection = await this.acquireConnectionForBrowser(
      context.telemetryReporter,
      params,
      context.cancellationToken,
    );
    if (typeof connection === 'string') {
      return connection; // an error
    }

    this._connection = connection;
    connection.onDisconnected(
      () => {
        this._connection = undefined;
        if (this._targetManager) {
          this._targetManager.dispose();
          this._targetManager = undefined;
          this._onTargetListChangedEmitter.fire();
        }

        if (this._lastLaunchParams === params && params.restart) {
          this._scheduleAttach(params, context);
        } else {
          this._onTerminatedEmitter.fire({ killed: true, code: 0 });
        }
      },
      undefined,
      this._disposables,
    );

    const targetManager = (this._targetManager = await BrowserTargetManager.connect(
      connection,
      undefined,
      this.pathResolver,
      params,
      this.logger,
      context.telemetryReporter,
      context.targetOrigin,
    ));
    if (!targetManager) return;

    targetManager.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    targetManager.onTargetAdded(() => {
      this._onTargetListChangedEmitter.fire();
    });
    targetManager.onTargetRemoved(target => {
      this._onTargetListChangedEmitter.fire();
      if (!targetManager.targetList().length && target.canAttach()) {
        // graceful exit
        this._onTerminatedEmitter.fire({ killed: true, code: 0 });
      }
    });

    const result = await Promise.race([
      targetManager.waitForMainTarget(createTargetFilterForConfig(params)),
      delay(params.timeout).then(() =>
        localize(
          'chrome.attach.noMatchingTarget',
          "Can't find a valid target that matches {0} within {1}ms",
          params.urlFilter || params.url,
          params.timeout,
        ),
      ),
    ]);

    return typeof result === 'string' ? result : undefined;
  }

  private async acquireConnectionForBrowser(
    rawTelemetryReporter: ITelemetryReporter,
    params: AnyChromiumAttachConfiguration,
    cancellationToken: CancellationToken,
  ) {
    const browserURL = `http://${params.address}:${params.port}`;
    while (this._lastLaunchParams === params) {
      try {
        return await launcher.attach(
          { browserURL },
          cancellationToken,
          this.logger,
          rawTelemetryReporter,
        );
      } catch (e) {
        if (cancellationToken.isCancellationRequested) {
          return localize(
            'attach.cannotConnect',
            'Cannot connect to the target at {0}: {1}',
            browserURL,
            e.message,
          );
        }

        await delay(1000);
      }
    }

    return localize(
      'attach.cannotConnect',
      'Cannot connect to the target at {0}: {1}',
      browserURL,
      'Cancelled',
    );
  }

  async terminate(): Promise<void> {
    this._lastLaunchParams = undefined;
    this._connection?.close();
  }

  public disconnect(): Promise<void> {
    return this.terminate();
  }

  async restart(): Promise<void> {
    // no-op
  }

  targetList(): ITarget[] {
    const manager = this._targetManager;
    return manager ? manager.targetList() : [];
  }
}
