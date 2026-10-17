import type { DesktopSession } from "./types";

/** Unranked legacy chats retain their saved order; never infer a human origin. */
export function orderedChats(sessions: DesktopSession[]): DesktopSession[] {
	return [...sessions].sort((a, b) => {
		const left = a.lastUserSubmission,
			right = b.lastUserSubmission;
		if (!left || !right) return left ? -1 : right ? 1 : 0;
		return (
			right.at - left.at ||
			right.sequence - left.sequence ||
			a.id.localeCompare(b.id)
		);
	});
}
