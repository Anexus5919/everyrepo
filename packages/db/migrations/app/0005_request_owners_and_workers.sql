CREATE TABLE `request_owner` (
	`repo_id` integer NOT NULL,
	`owner` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `owner`),
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `request_owner_owner` ON `request_owner` (`owner`);--> statement-breakpoint
CREATE TABLE `worker` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`job_id` integer
);
