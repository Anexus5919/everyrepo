CREATE TABLE `chunk` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`kind` text NOT NULL,
	`header` text NOT NULL,
	`content` text NOT NULL,
	`identifiers` text NOT NULL,
	`tokens` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunk_file` ON `chunk` (`file_id`);