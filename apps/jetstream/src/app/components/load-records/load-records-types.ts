import {
  BulkJobWithBatches,
  EntityParticleRecord,
  InsertUpdateUpsertDelete,
  MapOf,
  RecordAttributes,
  SalesforceOrgUi,
} from '@jetstream/types';
import { FieldType } from 'jsforce';
import { DownloadType, PrepareDataResponseError } from '../shared/load-records-results/load-records-results-types';

export type LocalOrGoogle = 'local' | 'google';

export interface FieldWithRelatedEntities {
  label: string;
  name: string;
  type: FieldType;
  soapType: string;
  typeLabel: string;
  externalId: boolean;
  referenceTo?: string[];
  relationshipName?: string;
  relatedFields?: MapOf<FieldRelatedEntity[]>;
}

export interface FieldRelatedEntity {
  name: string;
  label: string;
  type: string;
  isExternalId: boolean;
}

export interface Step {
  idx: number;
  name: StepName;
  label: string;
  active: boolean;
  enabled: boolean;
}

export type StepName = 'sobjectAndFile' | 'fieldMapping' | 'automationDeploy' | 'loadRecords' | 'automationRollback';

type RecordAttributesWithRelatedRecords = RecordAttributes & { relatedRecords: EntityParticleRecord[] };

export type ApiModeBulk = 'BULK';
export type ApiModeBatch = 'BATCH';
export type ApiMode = ApiModeBulk | ApiModeBatch;

export type EntityParticleRecordWithRelatedExtIds = EntityParticleRecord & { attributes: RecordAttributesWithRelatedRecords };
export type NonExtIdLookupOption = 'FIRST' | 'ERROR_IF_MULTIPLE';

export interface FieldMapping {
  [field: string]: FieldMappingItem;
}

export interface FieldMappingItem {
  csvField: string;
  targetField: string | null;
  mappedToLookup: boolean;
  selectedReferenceTo?: string;
  relationshipName?: string;
  targetLookupField?: string;
  fieldMetadata: FieldWithRelatedEntities;
  relatedFieldMetadata?: FieldRelatedEntity;
  isDuplicateMappedField?: boolean;
  lookupOptionUseFirstMatch: NonExtIdLookupOption;
  lookupOptionNullIfNoMatch: boolean;
  isBinaryBodyField: boolean;
}

export interface PrepareDataPayload {
  uuid: string;
  org: SalesforceOrgUi;
  data: any[];
  fieldMapping: FieldMapping;
  sObject: string;
  insertNulls?: boolean; // defaults to false
  dateFormat: string;
  apiMode: ApiMode;
}

export interface PrepareDataResponse {
  uuid: string;
  data: any[];
  errors: PrepareDataResponseError[];
  queryErrors: string[];
}

// export interface PrepareDataResponseError {
//   row: number;
//   record: any;
//   errors: string[];
// }

export interface LoadDataPayload {
  uuid: string;
  org: SalesforceOrgUi;
  data: any[];
  zipData?: ArrayBuffer;
  sObject: string;
  apiMode: ApiMode;
  type: InsertUpdateUpsertDelete;
  batchSize: number;
  serialMode?: boolean;
  externalId?: string; // required for upsert, ignored for all others.
  assignmentRuleId?: string; // only allowed for lead / case
  binaryBodyField?: string;
}

export interface LoadDataBulkApi {
  id?: string;
  data: any;
  batchNumber: number;
  completed: boolean;
  success: boolean;
  errorMessage?: string;
}

export interface LoadDataBulkApiStatusPayload {
  jobInfo: BulkJobWithBatches;
  totalBatches: number;
  batchSummary: Omit<LoadDataBulkApi, 'data'>[];
}

export interface LoadDataBatchApiProgress {
  total: number;
  success: number;
  failure: number;
}

// export type DownloadType = 'results' | 'failures';
// export type DownloadAction = 'view' | 'download';

export interface DownloadModalData {
  open: boolean;
  data: any[];
  header: string[];
  fileNameParts: string[];
}

export interface ViewModalData extends Omit<DownloadModalData, 'fileNameParts'> {
  type: DownloadType;
}

export type MapOfCustomMetadataRecord = MapOf<CustomMetadataRecord>;

export interface CustomMetadataRecord {
  metadata: string;
  fullName: string;
  record: any;
}

export interface LoadHistoryItem {
  key: string; // org:uuid
  uuid: string;
  bulkJobId: string | null;
  resultsDataId: string | null; // id of other entries
  date: Date;
  org: string;
  sObject: string;
  apiMode: ApiMode;
  operation: InsertUpdateUpsertDelete;
  batchSize: number;
  serialMode?: boolean;
  externalId?: string;
  insertNulls?: boolean;
  dateFormat: string;
  assignmentRuleId?: string;
  fieldMapping: FieldMapping;
  startTime: string;
  endTime: string;
  total: number;
  success: number;
  failure: number;
  errors: PrepareDataResponseError[];
}

export interface LoadHistoryItemWithOrg extends LoadHistoryItem {
  orgName: string;
}

export interface LoadHistoryFileItem {
  key: string; // org:uuid:type
  parentUuid: string;
  type: 'INPUT' | 'RESULTS';
  data: any[];
}
