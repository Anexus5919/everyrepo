CREATE TABLE `usage_counter` (
	`hour` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`neurons` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour`, `provider`, `model`)
);
--> statement-breakpoint
-- Daily totals become the last hour of their day, so a rolling window never undercounts them
INSERT INTO `usage_counter` (`hour`, `provider`, `model`, `requests`, `tokens`, `neurons`) SELECT `day` || 'T23', `provider`, `model`, `requests`, `tokens`, `neurons` FROM `budget_counter`;
