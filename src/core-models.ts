import os from "node:os";
export interface Selection {
	provider: string;
	model: string;
}
export interface ProviderCatalog {
	checkedAt: number;
	expiresAt: number;
	providers: {
		provider: string;
		label: string;
		status: string;
		credential: string;
		message?: string;
		models: (Selection & { label: string; tools: true })[];
	}[];
}
export interface ModelsHost {
	catalog(cwd?: string, refresh?: boolean): Promise<ProviderCatalog>;
	request(
		cwd: string,
		selection: Selection,
		route: string,
		body: unknown,
		signal: AbortSignal,
	): Promise<unknown>;
}
interface CatalogAPI {
	list(
		settings: unknown,
		options?: { refresh?: boolean },
	): Promise<ProviderCatalog>;
}
interface GatewayAPI {
	request(route: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}
interface CoreModelsAPI {
	ModelCatalog?: new () => CatalogAPI;
	ModelGateway?: new (settings: unknown, selection: Selection) => GatewayAPI;
	loadWorkspaceSettings(cwd: string): Promise<unknown>;
}
/** Uses existing Core settings and environment credentials on the host. No credentials enter IPC. */
export class CoreModelsHost implements ModelsHost {
	private api?: Promise<CoreModelsAPI>;
	private loadAPI() {
		this.api ??= import("@cybergarage/orbit").then(
			(api) => api as unknown as CoreModelsAPI,
		);
		return this.api;
	}
	private instance?: CatalogAPI;
	async catalog(cwd = os.homedir(), refresh = false): Promise<ProviderCatalog> {
		const api = await this.loadAPI();
		if (!api.ModelCatalog)
			throw new Error(
				"Bundled Orbit Core needs provider catalog support; update its pinned artifact",
			);
		this.instance ??= new api.ModelCatalog();
		let settings: unknown;
		try {
			settings = await api.loadWorkspaceSettings(cwd);
		} catch {
			throw new Error("Model settings could not be loaded");
		}
		return this.instance.list(settings, { refresh });
	}
	async request(
		cwd: string,
		selection: Selection,
		route: string,
		body: unknown,
		signal: AbortSignal,
	) {
		const api = await this.loadAPI();
		if (!api.ModelGateway)
			throw new Error(
				"Bundled Orbit Core needs provider gateway support; update its pinned artifact",
			);
		let settings: unknown;
		try {
			settings = await api.loadWorkspaceSettings(cwd);
		} catch {
			throw new Error("Model settings could not be loaded");
		}
		return new api.ModelGateway(settings, selection).request(
			route,
			body,
			signal,
		);
	}
}
export function requireCatalogSelection(
	catalog: ProviderCatalog,
	selection: Selection,
) {
	if (
		!catalog.providers.some(
			(provider) =>
				provider.status === "available" &&
				provider.provider === selection.provider &&
				provider.models.some((model) => model.model === selection.model),
		)
	)
		throw new Error(
			"Selected provider/model is unavailable or unsupported; refresh models",
		);
}
