CREATE TABLE `wiki_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wiki_page` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`parent_slug` text,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`clusters` text NOT NULL,
	`files` text NOT NULL,
	`status` text NOT NULL,
	`markdown` text,
	`citations` text,
	`model` text,
	`input_hash` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_page_slug_unique` ON `wiki_page` (`slug`);