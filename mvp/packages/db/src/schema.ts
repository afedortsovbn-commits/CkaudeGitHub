import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Drizzle-описание таблиц; источник истины — SQL-миграции в ../migrations.
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
});

export const event = pgTable('event', {
  id: uuid('id').primaryKey(),
  type: text('type').notNull(),
  version: integer('version').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  source: text('source').notNull(),
  traceId: text('trace_id'),
  data: jsonb('data').notNull(),
});

export const featureFlag = pgTable('feature_flag', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
