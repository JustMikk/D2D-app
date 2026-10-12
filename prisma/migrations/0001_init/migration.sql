-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "passwordHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "monitoringAckAt" DATETIME,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "preferences" TEXT NOT NULL DEFAULT '{}',
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "data" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'intake:write',
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Rep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "phone" TEXT,
    "timeZone" TEXT NOT NULL,
    "baseAddress" TEXT,
    "baseLat" REAL,
    "baseLng" REAL,
    "dailyCapacity" INTEGER NOT NULL DEFAULT 20,
    "workdays" TEXT NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI,SAT',
    "dayStartLocal" TEXT NOT NULL DEFAULT '09:00',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "onShift" BOOLEAN NOT NULL DEFAULT false,
    "lastLat" REAL,
    "lastLng" REAL,
    "lastAccuracyM" REAL,
    "lastLocationAt" DATETIME,
    "lastLocationSource" TEXT,
    "crmId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Rep_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepUnavailability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepUnavailability_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Rep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "website" TEXT,
    "domain" TEXT,
    "street" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "crmId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Door" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalProspectId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'API',
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewReason" TEXT,
    "reviewDetail" TEXT,
    "closedReason" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "street" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "streetKey" TEXT,
    "lat" REAL,
    "lng" REAL,
    "geocodeQuality" TEXT,
    "addressSource" TEXT,
    "placeId" TEXT,
    "jobCity" TEXT,
    "jobState" TEXT,
    "workplaceType" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "contactLinkedinUrl" TEXT,
    "qualificationNotes" TEXT NOT NULL DEFAULT '',
    "preferredVisitWindow" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rolloverCount" INTEGER NOT NULL DEFAULT 0,
    "lastOutcome" TEXT,
    "nextStepAt" DATETIME,
    "preferredRepId" TEXT,
    "crmId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    CONSTRAINT "Door_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Door_preferredRepId_fkey" FOREIGN KEY ("preferredRepId") REFERENCES "Rep" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DoNotKnock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "doorId" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "scheduledFor" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assignedBy" TEXT NOT NULL,
    "assignedById" TEXT,
    "reason" TEXT,
    "driveMinutes" INTEGER,
    "routeOrder" INTEGER,
    "plannedArrival" DATETIME,
    "routePlanId" TEXT,
    "arrivedAt" DATETIME,
    "arrivedLat" REAL,
    "arrivedLng" REAL,
    "arrivedDistM" REAL,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Assignment_doorId_fkey" FOREIGN KEY ("doorId") REFERENCES "Door" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Assignment_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Rep" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Assignment_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "RoutePlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoutePlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startLat" REAL NOT NULL,
    "startLng" REAL NOT NULL,
    "totalDriveMinutes" INTEGER,
    "totalDistanceM" INTEGER,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoutePlan_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Rep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "startLat" REAL,
    "startLng" REAL,
    "endLat" REAL,
    "endLng" REAL,
    "endedBy" TEXT,
    CONSTRAINT "Shift_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Rep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LocationPing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "accuracyM" REAL,
    "source" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LocationPing_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Rep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "doorId" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "outcome" TEXT NOT NULL,
    "decisionMakerPresent" BOOLEAN,
    "notes" TEXT NOT NULL DEFAULT '',
    "nextStepAt" DATETIME,
    "recordedAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" REAL,
    "lng" REAL,
    "accuracyM" REAL,
    "distanceFromDoorM" REAL,
    "offSite" BOOLEAN NOT NULL DEFAULT false,
    "assignmentMismatch" BOOLEAN NOT NULL DEFAULT false,
    "formDurationS" INTEGER,
    "crmSyncedAt" DATETIME,
    CONSTRAINT "Visit_doorId_fkey" FOREIGN KEY ("doorId") REFERENCES "Door" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Visit_repId_fkey" FOREIGN KEY ("repId") REFERENCES "Rep" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Visit_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "visitId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Media_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Media_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "dedupeKey" TEXT,
    "key" TEXT,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorKeyId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "data" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "merged" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_email_idx" ON "Invite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Rep_userId_key" ON "Rep"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Rep_crmId_key" ON "Rep"("crmId");

-- CreateIndex
CREATE UNIQUE INDEX "RepUnavailability_repId_date_key" ON "RepUnavailability"("repId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Company_crmId_key" ON "Company"("crmId");

-- CreateIndex
CREATE INDEX "Company_nameKey_idx" ON "Company"("nameKey");

-- CreateIndex
CREATE INDEX "Company_domain_idx" ON "Company"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Door_externalProspectId_key" ON "Door"("externalProspectId");

-- CreateIndex
CREATE UNIQUE INDEX "Door_crmId_key" ON "Door"("crmId");

-- CreateIndex
CREATE INDEX "Door_status_idx" ON "Door"("status");

-- CreateIndex
CREATE INDEX "Door_companyId_streetKey_idx" ON "Door"("companyId", "streetKey");

-- CreateIndex
CREATE INDEX "Door_nextStepAt_idx" ON "Door"("nextStepAt");

-- CreateIndex
CREATE UNIQUE INDEX "DoNotKnock_kind_value_key" ON "DoNotKnock"("kind", "value");

-- CreateIndex
CREATE INDEX "Assignment_repId_scheduledFor_status_idx" ON "Assignment"("repId", "scheduledFor", "status");

-- CreateIndex
CREATE INDEX "Assignment_doorId_status_idx" ON "Assignment"("doorId", "status");

-- CreateIndex
CREATE INDEX "RoutePlan_repId_date_idx" ON "RoutePlan"("repId", "date");

-- CreateIndex
CREATE INDEX "Shift_repId_date_idx" ON "Shift"("repId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "LocationPing_clientId_key" ON "LocationPing"("clientId");

-- CreateIndex
CREATE INDEX "LocationPing_repId_recordedAt_idx" ON "LocationPing"("repId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_clientId_key" ON "Visit"("clientId");

-- CreateIndex
CREATE INDEX "Visit_doorId_idx" ON "Visit"("doorId");

-- CreateIndex
CREATE INDEX "Visit_repId_recordedAt_idx" ON "Visit"("repId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Media_clientId_key" ON "Media"("clientId");

-- CreateIndex
CREATE INDEX "Media_visitId_idx" ON "Media"("visitId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_key_idx" ON "Job"("key");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
