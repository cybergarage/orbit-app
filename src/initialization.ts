/** Published core APIs exist; the Electron storage/lifecycle adapter is still required. */
export const initializationAvailability = {
	available: false,
	coreVersion: "0.9.3",
	reason:
		"Published Orbit core 0.9.3 provides initialization APIs. Controls remain disabled until the Electron adapter safely handles container storage registrations, settings fields, owned cache and verified writer shutdown.",
} as const;
