import { useEffect, useRef, useState } from "react";
export interface Choice {
	model: string;
	provider: string;
	label?: string;
}
export interface Catalog {
	providers: {
		provider: string;
		label: string;
		status: string;
		credential: string;
		message?: string;
		models: Choice[];
	}[];
}
export function ModelSelector({
	value,
	load,
	save,
	disabled = false,
	label = "Model",
}: {
	value?: Choice;
	load: (refresh?: boolean) => Promise<Catalog>;
	save: (choice: Choice) => Promise<void>;
	disabled?: boolean;
	label?: string;
}) {
	const [open, setOpen] = useState(false);
	const [catalog, setCatalog] = useState<Catalog>();
	const [retry, setRetry] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const locked = useRef(false);
	const root = useRef<HTMLFieldSetElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const loader = useRef(load);
	loader.current = load;
	useEffect(() => {
		if (!open) return;
		let live = true;
		setLoading(true);
		setError("");
		setCatalog(undefined);
		loader
			.current(retry > 0)
			.then((items) => {
				if (live) setCatalog(items);
			})
			.catch((reason) => {
				if (live)
					setError(
						reason instanceof Error
							? reason.message
							: "Model catalog unavailable",
					);
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		const outside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const escapeKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
				trigger.current?.focus();
			}
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escapeKey);
		return () => {
			live = false;
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escapeKey);
		};
	}, [open, retry]);
	useEffect(() => {
		if (value?.model || value?.provider || disabled) setOpen(false);
	}, [value?.model, value?.provider, disabled]);
	const available = catalog?.providers.filter(
		(item) => item.status === "available" && item.models.length > 0,
	);
	const close = () => {
		setOpen(false);
		// Saving temporarily disables the trigger; focus it after React clears busy.
		setTimeout(() => trigger.current?.focus(), 0);
	};
	return (
		<fieldset
			className="model-selector"
			aria-label="Model selection"
			ref={root}
			onBlur={(event) => {
				if (
					event.relatedTarget &&
					!event.currentTarget.contains(event.relatedTarget as Node)
				)
					setOpen(false);
			}}
			onKeyDown={(event) => {
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
					return;
				const buttons = Array.from(
					event.currentTarget.querySelectorAll<HTMLButtonElement>(
						".model-popover button:not(:disabled)",
					),
				);
				if (buttons.length === 0) return;
				event.preventDefault();
				const index = buttons.indexOf(
					document.activeElement as HTMLButtonElement,
				);
				const next =
					event.key === "Home"
						? 0
						: event.key === "End"
							? buttons.length - 1
							: index < 0
								? event.key === "ArrowUp"
									? buttons.length - 1
									: 0
								: (index +
										(event.key === "ArrowUp" ? -1 : 1) +
										buttons.length) %
									buttons.length;
				buttons[next]?.focus();
			}}
		>
			<button
				type="button"
				className="model-trigger"
				aria-label={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled || busy}
				ref={trigger}
				title={value ? `${value.provider} / ${value.model}` : undefined}
				onClick={() => {
					setRetry(0);
					setOpen(!open);
				}}
			>
				{value
					? `${catalog?.providers.find((item) => item.provider === value.provider)?.label ?? value.provider} / ${value.model}`
					: "Select model"}{" "}
				<span aria-hidden="true">⌄</span>
			</button>
			{open && (
				<div className="model-popover" role="dialog" aria-label={label}>
					{error && <p role="alert">{error}</p>}
					{loading && <p role="status">Loading models…</p>}
					{!loading &&
						available?.flatMap((item) =>
							item.models.map((choice) => (
								<button
									type="button"
									className="model-option"
									key={`${choice.provider}/${choice.model}`}
									disabled={busy}
									aria-pressed={
										choice.provider === value?.provider &&
										choice.model === value?.model
									}
									onClick={async () => {
										if (locked.current) return;
										locked.current = true;
										setBusy(true);
										setError("");
										try {
											await save({
												model: choice.model,
												provider: choice.provider,
											});
											close();
										} catch (reason) {
											setError(
												reason instanceof Error
													? reason.message
													: "Model selection failed",
											);
										} finally {
											locked.current = false;
											setBusy(false);
										}
									}}
								>
									<span>
										{item.label} / {choice.label ?? choice.model}
									</span>
									<span aria-hidden="true">
										{choice.provider === value?.provider &&
										choice.model === value?.model
											? "✓"
											: ""}
									</span>
								</button>
							)),
						)}
					{!loading && available?.length === 0 && <p>No eligible models</p>}
					{!loading &&
						available?.length === 0 &&
						catalog?.providers
							.filter((item) => item.status !== "available")
							.map((item) => (
								<p key={item.provider}>
									{item.label}: {item.message ?? "Unavailable"}
								</p>
							))}
					{(error || (!loading && available?.length === 0)) && (
						<button
							type="button"
							disabled={busy || loading}
							onClick={() => setRetry(retry + 1)}
						>
							Retry loading models
						</button>
					)}
				</div>
			)}
		</fieldset>
	);
}
