CREATE TABLE `model_rest` (
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`until` integer NOT NULL,
	`reason` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `model`)
);
