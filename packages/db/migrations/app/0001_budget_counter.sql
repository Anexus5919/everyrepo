CREATE TABLE `budget_counter` (
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`neurons` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `provider`, `model`)
);
