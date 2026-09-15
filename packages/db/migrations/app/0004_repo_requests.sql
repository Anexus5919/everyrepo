CREATE TABLE `github_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`etag` text,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `repo_request` (
	`repo_id` integer PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`count` integer DEFAULT 0 NOT NULL,
	`estimate` text,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`decided_at` integer NOT NULL,
	`decided_by` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repo_request_decision` ON `repo_request` (`decision`,`decided_at`);--> statement-breakpoint
CREATE TABLE `request_voter` (
	`repo_id` integer NOT NULL,
	`voter` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `voter`),
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `request_voter_created` ON `request_voter` (`created_at`);--> statement-breakpoint
ALTER TABLE `index_job` ADD `origin` text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE `index_job` ADD `run_after` integer;--> statement-breakpoint
ALTER TABLE `index_job` ADD `deferrals` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `index_job` ADD `progress` text;--> statement-breakpoint
ALTER TABLE `repo` ADD `github_id` integer;--> statement-breakpoint
ALTER TABLE `repo` ADD `description` text;--> statement-breakpoint
ALTER TABLE `repo` ADD `stars` integer;--> statement-breakpoint
ALTER TABLE `repo` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repo` ADD `published_sha` text;--> statement-breakpoint
ALTER TABLE `repo` ADD `published_at` integer;