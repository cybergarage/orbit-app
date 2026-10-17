export const initializationAvailability = {
	available: true,
	coreVersion: "0.9.3",
	reason:
		"Preview App-owned targets, stop writers, then confirm permanent initialization.",
} as const;
export type InitializationMode = "settings" | "data" | "all";
export interface InitializationPreview {
	id: string;
	mode: InitializationMode;
	final: boolean;
	targets: { path: string; kind: string; files: number; bytes: number }[];
	retained: string[];
}
export const initializationScopes: {
	mode: InitializationMode;
	title: string;
	description: string;
}[] = [
	{
		mode: "settings",
		title: "Reset settings",
		description:
			"Reset App appearance preferences. Keep Chats, projects, schedules and working files.",
	},
	{
		mode: "data",
		title: "Reset conversations, projects and schedules",
		description:
			"Remove saved conversations, project registrations, memory within registered stores, schedules and execution history. Keep appearance and working files.",
	},
	{
		mode: "all",
		title: "Reset all app settings, saved data and owned cache",
		description:
			"Combine settings and saved-data initialization with the dedicated runtime health cache. Keep unknown objects and browser profile data.",
	},
];
