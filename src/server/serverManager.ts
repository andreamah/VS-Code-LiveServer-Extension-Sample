import * as vscode from 'vscode';
import * as net from 'net';
import { Disposable } from '../utils/dispose';
import { WSServer } from './wsServer';
import { HttpServer } from './httpServer';
import { StatusBarNotifier } from './serverUtils/statusBarNotifier';
import {
	AutoRefreshPreview,
	SettingUtil,
	Settings,
} from '../utils/settingsUtil';
import { DONT_SHOW_AGAIN, HOST } from '../utils/constants';
import TelemetryReporter from 'vscode-extension-telemetry';
import { EndpointManager } from '../infoManagers/endpointManager';
import { WorkspaceManager } from '../infoManagers/workspaceManager';
import { ConnectionManager } from '../infoManagers/connectionManager';
import { serverMsg } from '../manager';

export class Server extends Disposable {
	private readonly _httpServer: HttpServer;
	private readonly _wsServer: WSServer;
	private readonly _statusBar: StatusBarNotifier;
	private _isServerOn = false;
	private _wsConnected = false;
	private _httpConnected = false;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		endpointManager: EndpointManager,
		reporter: TelemetryReporter,
		workspaceManager: WorkspaceManager,
		private readonly _connectionManager: ConnectionManager
	) {
		super();
		this._httpServer = this._register(
			new HttpServer(_extensionUri, reporter, endpointManager, workspaceManager)
		);
		this._wsServer = this._register(
			new WSServer(reporter, endpointManager, workspaceManager)
		);
		this._statusBar = this._register(new StatusBarNotifier(_extensionUri));

		this._register(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (
					e.contentChanges &&
					e.contentChanges.length > 0 &&
					this._reloadOnAnyChange &&
					this._httpServer.hasServedFile(e.document.uri.fsPath)
				) {
					this._wsServer.refreshBrowsers();
				}
			})
		);

		this._register(
			vscode.workspace.onDidSaveTextDocument((e) => {
				if (
					this._reloadOnSave &&
					this._httpServer.hasServedFile(e.uri.fsPath)
				) {
					this._wsServer.refreshBrowsers();
				}
			})
		);

		this._register(
			vscode.workspace.onDidRenameFiles(() => {
				if (this._reloadOnAnyChange || this._reloadOnSave) {
					this._wsServer.refreshBrowsers();
				}
			})
		);
		this._register(
			vscode.workspace.onDidDeleteFiles(() => {
				if (this._reloadOnAnyChange || this._reloadOnSave) {
					this._wsServer.refreshBrowsers();
				}
			})
		);
		this._register(
			vscode.workspace.onDidCreateFiles(() => {
				if (this._reloadOnAnyChange || this._reloadOnSave) {
					this._wsServer.refreshBrowsers();
				}
			})
		);

		this._register(
			this._httpServer.onNewReqProcessed((e) => {
				this._onNewReqProcessed.fire(e);
			})
		);

		this._register(
			this._wsServer.onConnected(() => {
				this._wsConnected = true;
				if (this._wsConnected && this._httpConnected) {
					this.connected();
				}
			})
		);

		this._register(
			this._httpServer.onConnected((e) => {
				this._httpConnected = true;
				if (this._wsConnected && this._httpConnected) {
					this.connected();
				}
			})
		);

		this._register(
			this._connectionManager.onConnected((e) => {
				this._httpServer.injectorWSUri = e.wsURI;
			})
		)

		vscode.commands.executeCommand('setContext', 'LivePreviewServerOn', false);
	}

	public get isRunning(): boolean {
		return this._isServerOn;
	}

	public updateConfigurations() {
		this._statusBar.updateConfigurations();
	}

	private readonly _onNewReqProcessed = this._register(
		new vscode.EventEmitter<serverMsg>()
	);
	public readonly onNewReqProcessed = this._onNewReqProcessed.event;

	private get _reloadOnAnyChange() {
		return (
			SettingUtil.GetConfig(this._extensionUri).autoRefreshPreview ==
			AutoRefreshPreview.onAnyChange
		);
	}

	private get _reloadOnSave() {
		return (
			SettingUtil.GetConfig(this._extensionUri).autoRefreshPreview ==
			AutoRefreshPreview.onSave
		);
	}

	public closeServer(): void {
		this._httpServer.close();
		this._wsServer.close();
		this._isServerOn = false; // TODO: find error conditions and return false when needed
		this._statusBar.ServerOff();

		this.showServerStatusMessage('Server Closed');
		vscode.commands.executeCommand('setContext', 'LivePreviewServerOn', false);
	}

	public openServer(port: number): boolean {
		this._httpConnected = false;
		this._wsConnected = false;
		if (this._extensionUri) {
			this.findFreePort(port, (freePort: number) => {
				this._httpServer.start(freePort);
				this._wsServer.start(freePort);
			});
			return true;
		}
		return false;
	}

	private findFreePort(
		startPort: number,
		callback: (port: number) => void
	): void {
		let port = startPort;
		const sock = new net.Socket();

		sock.setTimeout(500);
		sock.on('connect', function () {
			sock.destroy();
			port++;
			sock.connect(port, HOST);
		});
		sock.on('error', function (e) {
			callback(port);
		});
		sock.on('timeout', function () {
			callback(port);
		});
		sock.connect(port, HOST);
	}

	private connected() {
		this._isServerOn = true;
		this._statusBar.ServerOn(this._httpServer.port);

		this.showServerStatusMessage(
			`Server Opened on Port ${this._httpServer.port}`
		);
		this._connectionManager.connected({
			port: this._httpServer.port,
			ws_port: this._wsServer.ws_port,
		});
		this._connectionManager.resolveExternalHTTPUri().then((uri) => {
			this._wsServer.externalHostName = uri.toString();
		})
		vscode.commands.executeCommand('setContext', 'LivePreviewServerOn', true);
	}

	private showServerStatusMessage(messsage: string) {
		if (
			SettingUtil.GetConfig(this._extensionUri).showServerStatusNotifications
		) {
			vscode.window
				.showInformationMessage(messsage, DONT_SHOW_AGAIN)
				.then((selection: vscode.MessageItem | undefined) => {
					if (selection == DONT_SHOW_AGAIN) {
						SettingUtil.UpdateSettings(
							Settings.showServerStatusNotifications,
							false
						);
					}
				});
		}
	}
}
