CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`actor_id` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_secrets` (
	`name` text PRIMARY KEY,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_automations_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `charge_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`charge_id` integer NOT NULL,
	`kind` text DEFAULT 'late_fee' NOT NULL,
	`period` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`waived_at` integer,
	`waived_by` text,
	`waive_reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_charge_adjustments_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_charge_adjustments_charge_id_charges_id_fk` FOREIGN KEY (`charge_id`) REFERENCES `charges`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_charge_adjustments_waived_by_profiles_id_fk` FOREIGN KEY (`waived_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT "charge_adjustments_kind_check" CHECK("kind" in ('late_fee')),
	CONSTRAINT "charge_adjustments_amount_check" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `charges` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`tenancy_id` integer NOT NULL,
	`month` text NOT NULL,
	`amount` integer NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT 'due' NOT NULL,
	`extra` integer DEFAULT 0 NOT NULL,
	`rent_part` integer,
	`prorated_days` integer,
	`fees` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_charges_tenancy_id_tenancies_id_fk` FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON DELETE CASCADE,
	CONSTRAINT "charges_amount_check" CHECK("amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text,
	`tenancy_id` integer,
	`payment_id` integer,
	`kind` text NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`path` text,
	`created_at` integer NOT NULL,
	`batch_id` integer,
	CONSTRAINT `fk_documents_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_documents_tenancy_id_tenancies_id_fk` FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_documents_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_documents_batch_id_payment_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `payment_batches`(`id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`property_id` integer NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`submitted_by` text,
	`approved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`client_key` text,
	`recurring_id` integer,
	`period` text,
	CONSTRAINT `fk_expenses_property_id_properties_id_fk` FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_expenses_submitted_by_profiles_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_expenses_recurring_id_recurring_expenses_id_fk` FOREIGN KEY (`recurring_id`) REFERENCES `recurring_expenses`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`unit_id` integer,
	`tenant_id` integer,
	`name` text DEFAULT '' NOT NULL,
	`token` text NOT NULL,
	`pin_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_by` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_invites_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_invites_unit_id_units_id_fk` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_invites_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_invites_claimed_by_profiles_id_fk` FOREIGN KEY (`claimed_by`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `lease_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`tenancy_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`rent` integer NOT NULL,
	`due_day` integer NOT NULL,
	`deposit` integer DEFAULT 0 NOT NULL,
	`reason` text DEFAULT 'initial' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_lease_terms_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_lease_terms_tenancy_id_tenancies_id_fk` FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_lease_terms_created_by_profiles_id_fk` FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT "lease_terms_reason_check" CHECK("reason" in ('initial', 'renewal', 'revision')),
	CONSTRAINT "lease_terms_rent_check" CHECK("rent" > 0)
);
--> statement-breakpoint
CREATE TABLE `maintenance_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`unit_id` integer NOT NULL,
	`raised_by` text,
	`raised_by_name` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`photo_keys` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`client_key` text,
	CONSTRAINT `fk_maintenance_requests_unit_id_units_id_fk` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_maintenance_requests_raised_by_profiles_id_fk` FOREIGN KEY (`raised_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_maintenance_requests_assigned_to_profiles_id_fk` FOREIGN KEY (`assigned_to`) REFERENCES `profiles`(`id`),
	CONSTRAINT "maintenance_requests_status_check" CHECK("status" in ('open', 'in_progress', 'done'))
);
--> statement-breakpoint
CREATE TABLE `meter_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`unit_id` integer,
	`kind` text DEFAULT 'electricity' NOT NULL,
	`reading` real,
	`previous` real,
	`usage` real,
	`rate` integer DEFAULT 0 NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`confidence` real,
	`photo_path` text,
	`read_on` text,
	`charge_id` integer,
	`recorded_by` text,
	`recorded_by_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'approved' NOT NULL,
	`flag` text DEFAULT '' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`client_key` text,
	CONSTRAINT `fk_meter_readings_unit_id_units_id_fk` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meter_readings_charge_id_charges_id_fk` FOREIGN KEY (`charge_id`) REFERENCES `charges`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_meter_readings_recorded_by_profiles_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_meter_readings_approved_by_profiles_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT "meter_readings_status_check" CHECK("status" in ('pending', 'approved')),
	CONSTRAINT "meter_readings_usage_check" CHECK("usage" >= 0),
	CONSTRAINT "meter_readings_amount_check" CHECK("amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '/' NOT NULL,
	`entity` text DEFAULT '' NOT NULL,
	`entity_id` text,
	`dedupe_key` text NOT NULL,
	`read_at` integer,
	`pushed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_notifications_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_notifications_recipient_id_profiles_id_fk` FOREIGN KEY (`recipient_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `password_resets` (
	`token_hash` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_password_resets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `payment_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`tenancy_id` integer NOT NULL,
	`client_key` text NOT NULL,
	`amount` integer NOT NULL,
	`months` integer NOT NULL,
	`method` text NOT NULL,
	`utr` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`recorded_by` text,
	`paid_on` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`void_reason` text DEFAULT '' NOT NULL,
	`voided_by` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_payment_batches_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_payment_batches_tenancy_id_tenancies_id_fk` FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_payment_batches_recorded_by_profiles_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_payment_batches_voided_by_profiles_id_fk` FOREIGN KEY (`voided_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT "payment_batches_status_check" CHECK("status" in ('pending', 'confirmed', 'rejected', 'void')),
	CONSTRAINT "payment_batches_method_check" CHECK("method" in ('upi', 'cash', 'bank')),
	CONSTRAINT "payment_batches_amount_check" CHECK("amount" > 0),
	CONSTRAINT "payment_batches_months_check" CHECK("months" >= 1)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`charge_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`method` text NOT NULL,
	`utr` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`recorded_by` text,
	`paid_on` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`void_reason` text DEFAULT '' NOT NULL,
	`voided_by` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`batch_id` integer,
	CONSTRAINT `fk_payments_charge_id_charges_id_fk` FOREIGN KEY (`charge_id`) REFERENCES `charges`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_payments_recorded_by_profiles_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_payments_voided_by_profiles_id_fk` FOREIGN KEY (`voided_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_payments_batch_id_payment_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `payment_batches`(`id`),
	CONSTRAINT "payments_status_check" CHECK("status" in ('pending', 'confirmed', 'rejected', 'void')),
	CONSTRAINT "payments_method_check" CHECK("method" in ('upi', 'cash', 'bank')),
	CONSTRAINT "payments_amount_check" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `photo_data` (
	`key` text PRIMARY KEY,
	`data` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photo_uploads` (
	`key` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_photo_uploads_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_photo_uploads_uploaded_by_profiles_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY,
	`role` text NOT NULL,
	`owner_id` text NOT NULL,
	`full_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`upi_id` text DEFAULT '' NOT NULL,
	`electricity_rate` integer DEFAULT 800 NOT NULL,
	`water_rate` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`pan` text DEFAULT '' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	CONSTRAINT "profiles_role_check" CHECK("role" in ('owner', 'staff', 'tenant'))
);
--> statement-breakpoint
CREATE TABLE `properties` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`owner_id` text NOT NULL,
	`electricity_rate` integer,
	`water_rate` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_properties_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text DEFAULT '' NOT NULL,
	`auth` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_push_subscriptions_user_id_profiles_id_fk` FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_push_subscriptions_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`bucket` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`property_id` integer NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`next_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_recurring_expenses_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_recurring_expenses_property_id_properties_id_fk` FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_recurring_expenses_created_by_profiles_id_fk` FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT "recurring_expenses_frequency_check" CHECK("frequency" in ('monthly', 'quarterly', 'half_yearly', 'yearly')),
	CONSTRAINT "recurring_expenses_amount_check" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `request_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`request_id` integer NOT NULL,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`photo_path` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_request_comments_request_id_maintenance_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_request_comments_author_id_profiles_id_fk` FOREIGN KEY (`author_id`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `settlement_deductions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`settlement_id` integer NOT NULL,
	`kind` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_settlement_deductions_settlement_id_settlements_id_fk` FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON DELETE CASCADE,
	CONSTRAINT "settlement_deductions_kind_check" CHECK("kind" in ('damage', 'rent', 'utility', 'other')),
	CONSTRAINT "settlement_deductions_amount_check" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`tenancy_id` integer NOT NULL,
	`move_out_date` text NOT NULL,
	`deposit_held` integer DEFAULT 0 NOT NULL,
	`outstanding_rent` integer DEFAULT 0 NOT NULL,
	`pending_utilities` integer DEFAULT 0 NOT NULL,
	`advance_unused` integer DEFAULT 0 NOT NULL,
	`refund_amount` integer DEFAULT 0 NOT NULL,
	`refund_status` text DEFAULT 'pending' NOT NULL,
	`refund_method` text DEFAULT '' NOT NULL,
	`refund_ref` text DEFAULT '' NOT NULL,
	`refund_paid_on` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`finalized_at` integer,
	`finalized_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_settlements_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_settlements_tenancy_id_tenancies_id_fk` FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_settlements_finalized_by_profiles_id_fk` FOREIGN KEY (`finalized_by`) REFERENCES `profiles`(`id`),
	CONSTRAINT "settlements_status_check" CHECK("status" in ('draft', 'final')),
	CONSTRAINT "settlements_refund_status_check" CHECK("refund_status" in ('pending', 'paid'))
);
--> statement-breakpoint
CREATE TABLE `tenancies` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`unit_id` integer NOT NULL,
	`tenant_id` integer NOT NULL,
	`rent` integer NOT NULL,
	`due_day` integer DEFAULT 5 NOT NULL,
	`deposit` integer DEFAULT 0 NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`move_out_date` text,
	CONSTRAINT `fk_tenancies_unit_id_units_id_fk` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tenancies_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
	CONSTRAINT "tenancies_status_check" CHECK("status" in ('active', 'ended')),
	CONSTRAINT "tenancies_rent_check" CHECK("rent" > 0),
	CONSTRAINT "tenancies_due_day_check" CHECK("due_day" between 1 and 28)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_id` text NOT NULL,
	`user_id` text,
	`full_name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`id_note` text DEFAULT '' NOT NULL,
	`emergency_contact` text DEFAULT '' NOT NULL,
	`move_in_date` text,
	`deposit` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`pan` text DEFAULT '' NOT NULL,
	CONSTRAINT `fk_tenants_owner_id_profiles_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`),
	CONSTRAINT `fk_tenants_user_id_profiles_id_fk` FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`property_id` integer NOT NULL,
	`label` text NOT NULL,
	`type` text DEFAULT '2BHK' NOT NULL,
	`base_rent` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_units_property_id_properties_id_fk` FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON DELETE CASCADE,
	CONSTRAINT "units_base_rent_check" CHECK("base_rent" >= 0)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`password_changed_at` integer NOT NULL,
	`last_sign_in_at` integer
);
--> statement-breakpoint
CREATE INDEX `activity_log_actor_idx` ON `activity_log` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `automations_owner_name_uq` ON `automations` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `charge_adjustments_charge_kind_period_uq` ON `charge_adjustments` (`charge_id`,`kind`,`period`);--> statement-breakpoint
CREATE INDEX `charge_adjustments_owner_idx` ON `charge_adjustments` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `charges_tenancy_month_uq` ON `charges` (`tenancy_id`,`month`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_payment_uq` ON `documents` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_batch_uq` ON `documents` (`batch_id`);--> statement-breakpoint
CREATE INDEX `documents_tenancy_idx` ON `documents` (`tenancy_id`);--> statement-breakpoint
CREATE INDEX `expenses_property_idx` ON `expenses` (`property_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_client_key_uq` ON `expenses` (`client_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_recurring_period_uq` ON `expenses` (`recurring_id`,`period`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_uq` ON `invites` (`token`);--> statement-breakpoint
CREATE INDEX `invites_owner_idx` ON `invites` (`owner_id`);--> statement-breakpoint
CREATE INDEX `lease_terms_tenancy_idx` ON `lease_terms` (`tenancy_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `lease_terms_owner_idx` ON `lease_terms` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_requests_client_key_uq` ON `maintenance_requests` (`client_key`);--> statement-breakpoint
CREATE INDEX `maintenance_requests_unit_idx` ON `maintenance_requests` (`unit_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meter_readings_client_key_uq` ON `meter_readings` (`client_key`);--> statement-breakpoint
CREATE INDEX `meter_readings_unit_idx` ON `meter_readings` (`unit_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_uq` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_owner_idx` ON `notifications` (`owner_id`);--> statement-breakpoint
CREATE INDEX `password_resets_user_idx` ON `password_resets` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_batches_owner_key_uq` ON `payment_batches` (`owner_id`,`client_key`);--> statement-breakpoint
CREATE INDEX `payment_batches_tenancy_idx` ON `payment_batches` (`tenancy_id`);--> statement-breakpoint
CREATE INDEX `payments_charge_idx` ON `payments` (`charge_id`);--> statement-breakpoint
CREATE INDEX `payments_batch_idx` ON `payments` (`batch_id`);--> statement-breakpoint
CREATE INDEX `photo_uploads_owner_idx` ON `photo_uploads` (`owner_id`);--> statement-breakpoint
CREATE INDEX `profiles_owner_idx` ON `profiles` (`owner_id`);--> statement-breakpoint
CREATE INDEX `properties_owner_idx` ON `properties` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uq` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_key_bucket_uq` ON `rate_limits` (`key`,`bucket`);--> statement-breakpoint
CREATE INDEX `rate_limits_updated_idx` ON `rate_limits` (`updated_at`);--> statement-breakpoint
CREATE INDEX `recurring_expenses_owner_idx` ON `recurring_expenses` (`owner_id`);--> statement-breakpoint
CREATE INDEX `request_comments_request_idx` ON `request_comments` (`request_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `settlement_deductions_settlement_idx` ON `settlement_deductions` (`settlement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_tenancy_uq` ON `settlements` (`tenancy_id`);--> statement-breakpoint
CREATE INDEX `settlements_owner_idx` ON `settlements` (`owner_id`);--> statement-breakpoint
CREATE INDEX `tenancies_unit_idx` ON `tenancies` (`unit_id`);--> statement-breakpoint
CREATE INDEX `tenancies_tenant_idx` ON `tenancies` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `tenants_user_idx` ON `tenants` (`user_id`);--> statement-breakpoint
CREATE INDEX `tenants_owner_idx` ON `tenants` (`owner_id`);--> statement-breakpoint
CREATE INDEX `units_property_idx` ON `units` (`property_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
-- Money and meter invariants are enforced by triggers, because D1 has no interactive transactions.
-- Meter bills follow meter_readings.charge_id. Setting the link adds the reading's amount to the charge, clearing it
-- (or moving it) takes the amount off, in the same statement as the link change. D1 has no interactive
-- transactions; with these triggers one conditional UPDATE on meter_readings is enough to apply or remove a bill
-- atomically (see worker/server/domain/meters.ts).
CREATE TRIGGER `meter_bill_add` AFTER UPDATE OF `charge_id` ON `meter_readings`
WHEN NEW.`charge_id` IS NOT NULL AND (OLD.`charge_id` IS NULL OR OLD.`charge_id` <> NEW.`charge_id`)
BEGIN
  UPDATE `charges` SET `amount` = `amount` + NEW.`amount`, `extra` = `extra` + NEW.`amount` WHERE `id` = NEW.`charge_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `meter_bill_remove` AFTER UPDATE OF `charge_id` ON `meter_readings`
WHEN OLD.`charge_id` IS NOT NULL AND (NEW.`charge_id` IS NULL OR OLD.`charge_id` <> NEW.`charge_id`)
BEGIN
  UPDATE `charges` SET `amount` = max(0, `amount` - OLD.`amount`), `extra` = max(0, `extra` - OLD.`amount`) WHERE `id` = OLD.`charge_id`;
END;
--> statement-breakpoint
-- A reading deleted while its bill is still on the rent takes the bill with it.
CREATE TRIGGER `meter_bill_delete` AFTER DELETE ON `meter_readings`
WHEN OLD.`charge_id` IS NOT NULL
BEGIN
  UPDATE `charges` SET `amount` = max(0, `amount` - OLD.`amount`), `extra` = max(0, `extra` - OLD.`amount`) WHERE `id` = OLD.`charge_id`;
END;
--> statement-breakpoint
-- A confirmed payment can never take a month's confirmed total above what the month costs.
CREATE TRIGGER `payments_confirmed_fit_insert` BEFORE INSERT ON `payments`
WHEN NEW.`status` = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'pos:payment_exceeds_due')
  WHERE NEW.`amount` > (SELECT `amount` FROM `charges` WHERE `id` = NEW.`charge_id`)
    - coalesce((SELECT sum(`amount`) FROM `payments` WHERE `charge_id` = NEW.`charge_id` AND `status` = 'confirmed'), 0);
END;
--> statement-breakpoint
CREATE TRIGGER `payments_confirmed_fit_update` BEFORE UPDATE OF `status` ON `payments`
WHEN NEW.`status` = 'confirmed' AND OLD.`status` <> 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'pos:payment_exceeds_due')
  WHERE NEW.`amount` > (SELECT `amount` FROM `charges` WHERE `id` = NEW.`charge_id`)
    - coalesce((SELECT sum(`amount`) FROM `payments` WHERE `charge_id` = NEW.`charge_id` AND `status` = 'confirmed'), 0);
END;
--> statement-breakpoint
-- A tenant's multi-month "I have paid" claim: each month must still be due, and must not already have a claim waiting.
CREATE TRIGGER `payments_batch_claim_insert` BEFORE INSERT ON `payments`
WHEN NEW.`status` = 'pending' AND NEW.`batch_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'pos:payment_pending_exists')
  WHERE EXISTS (SELECT 1 FROM `payments` WHERE `charge_id` = NEW.`charge_id` AND `status` = 'pending');
  SELECT RAISE(ABORT, 'pos:payment_exceeds_due')
  WHERE NEW.`amount` > (SELECT `amount` FROM `charges` WHERE `id` = NEW.`charge_id`)
    - coalesce((SELECT sum(`amount`) FROM `payments` WHERE `charge_id` = NEW.`charge_id` AND `status` = 'confirmed'), 0);
END;
--> statement-breakpoint
-- Every month of a batch belongs to the batch's own tenancy.
CREATE TRIGGER `payments_batch_tenancy_insert` BEFORE INSERT ON `payments`
WHEN NEW.`batch_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'pos:payment_wrong_tenancy')
  WHERE (SELECT `tenancy_id` FROM `charges` WHERE `id` = NEW.`charge_id`)
    IS NOT (SELECT `tenancy_id` FROM `payment_batches` WHERE `id` = NEW.`batch_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `charge_fee_add` AFTER INSERT ON `charge_adjustments`
WHEN NEW.`waived_at` IS NULL
BEGIN
  UPDATE `charges` SET `amount` = `amount` + NEW.`amount`, `fees` = `fees` + NEW.`amount` WHERE `id` = NEW.`charge_id`;
END;
--> statement-breakpoint
-- A fee that has already been paid can't be waived (the month would then show more paid than it costs); the owner
-- voids the payment first.
CREATE TRIGGER `charge_fee_waive_guard` BEFORE UPDATE OF `waived_at` ON `charge_adjustments`
WHEN OLD.`waived_at` IS NULL AND NEW.`waived_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'pos:fee_already_paid')
  WHERE (SELECT `amount` FROM `charges` WHERE `id` = NEW.`charge_id`) - NEW.`amount`
    < coalesce((SELECT sum(`amount`) FROM `payments` WHERE `charge_id` = NEW.`charge_id` AND `status` = 'confirmed'), 0);
END;
--> statement-breakpoint
CREATE TRIGGER `charge_fee_waive` AFTER UPDATE OF `waived_at` ON `charge_adjustments`
WHEN OLD.`waived_at` IS NULL AND NEW.`waived_at` IS NOT NULL
BEGIN
  UPDATE `charges` SET `amount` = max(0, `amount` - NEW.`amount`), `fees` = max(0, `fees` - NEW.`amount`) WHERE `id` = NEW.`charge_id`;
END;
