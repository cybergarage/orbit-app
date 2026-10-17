/** The published Worker core does not yet export the approved initialization API. */
export const initializationAvailability = {
	available: false,
	coreVersion: "0.9.2",
	reason:
		"Initialization requires a published Orbit core release with the shared initialization API. The pinned 0.9.2 core does not provide it.",
} as const;
