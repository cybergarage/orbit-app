SHELL := /bin/sh
.DEFAULT_GOAL := run
.NOTPARALLEL:
.PHONY: run clean

run:
	@set -eu; \
	git diff --quiet && git diff --cached --quiet || { \
		echo '追跡済みファイルに未コミットの変更があります。'; \
		exit 1; \
	}; \
	git switch main; \
	git pull --ff-only; \
	npm ci; \
	npm run worker:build; \
	npm run dev

clean:
	@set -eu; \
	state="$$HOME/Library/Application Support/orbit-app/state.json"; \
	if [ ! -e "$$state" ]; then \
		echo 'state.json はありません。'; \
		exit 0; \
	fi; \
	printf '%s\n' \
		'Project・Chatの登録、設定、予定を初期化します。' \
		'会話・作業ファイルの実体は残りますが、自動再登録されません。' \
		'Appとタスクを停止済みで、初期化するなら RESET と入力してください。' > /dev/tty; \
	IFS= read -r answer < /dev/tty; \
	if [ "$$answer" != RESET ]; then \
		echo 'キャンセルしました。'; \
		exit 1; \
	fi; \
	osascript \
		-e 'on run argv' \
		-e 'tell application "Finder" to delete (POSIX file (item 1 of argv))' \
		-e 'end run' \
		"$$state"; \
	echo 'state.json をゴミ箱へ移動しました。'
