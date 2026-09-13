CREATE TABLE `index_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stages` text NOT NULL,
	`params` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`locked_by` text,
	`heartbeat_at` integer,
	`est_tokens` integer,
	`used_tokens` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `index_job_claim` ON `index_job` (`status`,`priority`,`id`);--> statement-breakpoint
CREATE TABLE `job_stage` (
	`job_id` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`job_id`, `stage`),
	FOREIGN KEY (`job_id`) REFERENCES `index_job`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `org` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`login` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_key_unique` ON `org` (`key`);--> statement-breakpoint
CREATE TABLE `repo` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`key` text NOT NULL,
	`default_branch` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`synced` integer DEFAULT false NOT NULL,
	`size_tier` text,
	`last_indexed_sha` text,
	`last_indexed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_key_unique` ON `repo` (`key`);