# ── RGBee ───────────────────────────────────────────────────────────────────
# Lint / check / deploy targets for the Cloudflare Worker + Durable Object game.
# Run `make` (or `make help`) to list everything.
SHELL := /bin/bash

ACCOUNT_ID ?= 63ea6216bbb2cdde804327be3f5e29e3
RESET_KEY  ?= buzz-reset-9f3a
URL        ?= https://rgbee.samuel-3ea.workers.dev

# ── ANSI colors ──────────────────────────────────────────────────────────────
B := \033[1m
D := \033[2m
R := \033[31m
G := \033[32m
Y := \033[33m
C := \033[36m
M := \033[35m
X := \033[0m

.DEFAULT_GOAL := help
.PHONY: help install typecheck check-js check dry-run deploy dev reset push ship clean

help: ## show this help
	@printf "$(B)$(M)🐝 RGBee$(X) $(D)— make <target>$(X)\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  $(C)$(B)%-11s$(X) %s\n", $$1, $$2}'
	@printf "\n"

install: ## npm install
	@printf "$(C)$(B)▸ installing deps$(X)\n"
	@npm install

typecheck: ## tsc --noEmit on the server TypeScript
	@printf "$(C)$(B)▸ typecheck$(X) $(D)(tsc --noEmit)$(X)\n"
	@npx tsc --noEmit
	@printf "$(G)✓ types clean$(X)\n"

check-js: ## syntax-check the inline frontend JS in public/index.html
	@printf "$(C)$(B)▸ check inline JS$(X)\n"
	@node scripts/check-html-js.cjs
	@printf "$(G)✓ inline JS OK$(X)\n"

check: typecheck check-js ## run all static checks (typecheck + inline JS)
	@printf "$(G)$(B)✓ all checks passed$(X)\n"

dry-run: check ## validate the Worker build + DO migration without deploying
	@printf "$(C)$(B)▸ wrangler deploy --dry-run$(X)\n"
	@CLOUDFLARE_ACCOUNT_ID=$(ACCOUNT_ID) npx wrangler deploy --dry-run --outdir dist
	@printf "$(G)✓ build validates$(X)\n"

deploy: check ## run checks, then deploy to Cloudflare
	@printf "$(C)$(B)▸ deploying to Cloudflare$(X)\n"
	@CLOUDFLARE_ACCOUNT_ID=$(ACCOUNT_ID) npx wrangler deploy
	@printf "$(G)$(B)✓ deployed$(X) $(D)→ $(URL)$(X)\n"

dev: ## local dev server (wrangler dev)
	@printf "$(C)$(B)▸ wrangler dev$(X)\n"
	@CLOUDFLARE_ACCOUNT_ID=$(ACCOUNT_ID) npx wrangler dev

reset: ## wipe the live leaderboard (host reset endpoint)
	@printf "$(Y)$(B)▸ wiping the live leaderboard$(X)\n"
	@curl -fsS "$(URL)/admin/reset?key=$(RESET_KEY)" >/dev/null
	@printf "$(G)✓ board wiped$(X) $(D)→ $(URL)$(X)\n"

push: ## git push to origin
	@printf "$(C)$(B)▸ git push$(X)\n"
	@git push

ship: deploy push ## check + deploy + push in one shot
	@printf "$(G)$(B)🚀 shipped$(X)\n"

clean: ## remove build artifacts
	@printf "$(C)$(B)▸ cleaning$(X)\n"
	@rm -rf dist
	@printf "$(G)✓ clean$(X)\n"
