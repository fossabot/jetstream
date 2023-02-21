import { css } from '@emotion/react';
import { logger } from '@jetstream/shared/client-logger';
import { ANALYTICS_KEYS, INDEXED_DB } from '@jetstream/shared/constants';
import { bulkApiGetJob, bulkApiGetRecords } from '@jetstream/shared/data';
import { checkIfBulkApiJobIsDone, convertDateToLocale, useBrowserNotifications, useRollbar } from '@jetstream/shared/ui-utils';
import { getSuccessOrFailureChar, pluralizeFromNumber } from '@jetstream/shared/utils';
import {
  BulkJobBatchInfo,
  BulkJobResultRecord,
  BulkJobWithBatches,
  InsertUpdateUpsertDelete,
  MapOf,
  SalesforceOrgUi,
  WorkerMessage,
} from '@jetstream/types';
import { FileDownloadModal, Grid, ProgressRing, SalesforceLogin, Spinner } from '@jetstream/ui';
import localforage from 'localforage';
import { FunctionComponent, useEffect, useRef, useState } from 'react';
import { useRecoilState } from 'recoil';
import { v4 as uuid } from 'uuid';
import { applicationCookieState } from '../../../../app-state';
import { useAmplitude } from '../../../core/analytics';
import * as fromJetstreamEvents from '../../../core/jetstream-events';
import { DownloadAction, DownloadType } from '../../../shared/load-records-results/load-records-results-types';
import LoadRecordsBulkApiResultsTable from '../../../shared/load-records-results/LoadRecordsBulkApiResultsTable';
import {
  ApiMode,
  DownloadModalData,
  FieldMapping,
  LoadDataBulkApiStatusPayload,
  LoadDataPayload,
  LoadHistoryItem,
  PrepareDataPayload,
  PrepareDataResponse,
  ViewModalData,
} from '../../load-records-types';
import { getFieldHeaderFromMapping, LoadRecordsBatchError } from '../../utils/load-records-utils';
import { getLoadWorker } from '../../utils/load-records-worker';
import LoadRecordsResultsModal from './LoadRecordsResultsModal';

type Status = 'Preparing Data' | 'Uploading Data' | 'Processing Data' | 'Finished' | 'Error';

const STATUSES: {
  PREPARING: Status;
  UPLOADING: Status;
  PROCESSING: Status;
  FINISHED: Status;
  ERROR: Status;
} = {
  PREPARING: 'Preparing Data',
  UPLOADING: 'Uploading Data',
  PROCESSING: 'Processing Data',
  FINISHED: 'Finished',
  ERROR: 'Error',
};

const CHECK_INTERVAL = 3000;
const MAX_INTERVAL_CHECK_COUNT = 200; // 3000*200/60=10 minutes

export interface LoadRecordsBulkApiResultsProps {
  selectedOrg: SalesforceOrgUi;
  selectedSObject: string;
  fieldMapping: FieldMapping;
  inputFileData: any[];
  inputZipFileData: ArrayBuffer;
  apiMode: ApiMode;
  loadType: InsertUpdateUpsertDelete;
  externalId?: string;
  batchSize: number;
  insertNulls: boolean;
  assignmentRuleId?: string;
  serialMode: boolean;
  dateFormat: string;
  onFinish: (results: { success: number; failure: number }) => void;
}

export const LoadRecordsBulkApiResults: FunctionComponent<LoadRecordsBulkApiResultsProps> = ({
  selectedOrg,
  selectedSObject,
  fieldMapping,
  inputFileData,
  inputZipFileData,
  apiMode,
  loadType,
  externalId,
  batchSize,
  insertNulls,
  assignmentRuleId,
  serialMode,
  dateFormat,
  onFinish,
}) => {
  const isMounted = useRef(null);
  const { trackEvent } = useAmplitude();
  const rollbar = useRollbar();
  const [{ serverUrl, google_apiKey, google_appId, google_clientId }] = useRecoilState(applicationCookieState);
  const [preparedData, setPreparedData] = useState<PrepareDataResponse>();
  const [prepareDataProgress, setPrepareDataProgress] = useState(0);
  const [loadWorker] = useState(() => getLoadWorker());
  const [status, setStatus] = useState<Status>(STATUSES.PREPARING);
  const [fatalError, setFatalError] = useState<string>(null);
  const [downloadError, setDownloadError] = useState<string>(null);
  const [jobInfo, setJobInfo] = useState<BulkJobWithBatches>();
  const [batchSummary, setBatchSummary] = useState<LoadDataBulkApiStatusPayload>();
  const [startTime, setStartTime] = useState<string>(null);
  const [endTime, setEndTime] = useState<string>(null);
  // Salesforce changes order of batches, so we want to ensure order is retained based on the input file
  const [batchIdByIndex, setBatchIdByIndex] = useState<MapOf<number>>();
  const [intervalCount, setIntervalCount] = useState<number>(0);
  const [downloadModalData, setDownloadModalData] = useState<DownloadModalData>({
    open: false,
    data: [],
    header: [],
    fileNameParts: [],
  });
  const [resultsModalData, setResultsModalData] = useState<ViewModalData>({ open: false, data: [], header: [], type: 'results' });
  const { notifyUser } = useBrowserNotifications(serverUrl, window.electron?.isFocused);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!loadWorker) {
      loadWorker.postMessage({ name: 'init', isElectron: window.electron?.isElectron });
    }
  }, [loadWorker]);

  useEffect(() => {
    if (batchSummary && batchSummary.batchSummary) {
      const batchSummariesWithId = batchSummary.batchSummary.filter((batch) => batch.id);
      if (Array.isArray(batchSummariesWithId)) {
        setBatchIdByIndex(
          batchSummariesWithId.reduce((output: MapOf<number>, batch) => {
            output[batch.id] = batch.batchNumber;
            return output;
          }, {})
        );
      }
    }
  }, [batchSummary]);

  useEffect(() => {
    if (loadWorker) {
      setStatus(STATUSES.PREPARING);
      setStartTime(convertDateToLocale(new Date(), { timeStyle: 'medium' }));
      setFatalError(null);
      const data: PrepareDataPayload = {
        uuid: uuid(),
        org: selectedOrg,
        data: inputFileData,
        // zipData: inputZipFileData,
        fieldMapping,
        sObject: selectedSObject,
        insertNulls,
        dateFormat,
        apiMode,
      };
      loadWorker.postMessage({ name: 'prepareData', data });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadWorker]);

  useEffect(() => {
    if (preparedData && preparedData.data.length) {
      const data: LoadDataPayload = {
        uuid: uuid(),
        org: selectedOrg,
        data: preparedData.data,
        zipData: inputZipFileData,
        sObject: selectedSObject,
        apiMode,
        type: loadType,
        batchSize,
        assignmentRuleId,
        serialMode,
        externalId,
      };
      loadWorker.postMessage({ name: 'loadData', data });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparedData]);

  /**
   * When jobInfo is modified, check to see if everything is done
   * If not done and status is processing, then continue polling
   */
  useEffect(() => {
    if (jobInfo && status !== STATUSES.ERROR && status !== STATUSES.FINISHED) {
      const isDone = checkIfBulkApiJobIsDone(jobInfo, batchSummary.totalBatches);
      if (isDone) {
        setStatus(STATUSES.FINISHED);
        handleSaveHistory();
        const numSuccess = jobInfo.numberRecordsProcessed - jobInfo.numberRecordsFailed;
        const numFailure = jobInfo.numberRecordsFailed + preparedData.errors.length;
        onFinish({ success: numSuccess, failure: numFailure });
        notifyUser(`Your ${jobInfo.operation} data load is finished`, {
          body: `${getSuccessOrFailureChar('success', numSuccess)} ${numSuccess.toLocaleString()} ${pluralizeFromNumber(
            'record',
            numSuccess
          )} loaded successfully - ${getSuccessOrFailureChar('failure', numFailure)} ${numFailure.toLocaleString()} ${pluralizeFromNumber(
            'record',
            numFailure
          )} failed`,
          tag: 'load-records',
        });
      } else if (status === STATUSES.PROCESSING && intervalCount < MAX_INTERVAL_CHECK_COUNT) {
        // we need to wait until all data is uploaded?
        setTimeout(async () => {
          if (!isMounted.current) {
            return;
          }
          const jobInfoWithBatches = await bulkApiGetJob(selectedOrg, jobInfo.id);
          if (!isMounted.current) {
            return;
          }
          // jobInfoWithBatches.batches = orderBy(jobInfoWithBatches.batches, ['createdDate']);
          const batches: BulkJobBatchInfo[] = [];
          // re-order (if needed)
          jobInfoWithBatches.batches.forEach((batch) => {
            batches[batchIdByIndex[batch.id]] = batch;
          });
          jobInfoWithBatches.batches = batches;
          setJobInfo(jobInfoWithBatches);
          setIntervalCount(intervalCount + 1);
        }, CHECK_INTERVAL);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobInfo, status]);

  useEffect(() => {
    if (loadWorker) {
      loadWorker.onmessage = (event: MessageEvent) => {
        if (!isMounted.current) {
          return;
        }
        const payload: WorkerMessage<
          'prepareData' | 'prepareDataProgress' | 'loadDataStatus' | 'loadData',
          {
            preparedData?: PrepareDataResponse;
            jobInfo?: BulkJobWithBatches;
            progress?: number;
            resultsSummary?: LoadDataBulkApiStatusPayload;
          },
          Error | LoadRecordsBatchError
        > = event.data;
        logger.log('[LOAD DATA]', payload.name, { payload });
        const dateString = convertDateToLocale(new Date(), { timeStyle: 'medium' });
        switch (payload.name) {
          case 'prepareData': {
            if (payload.error) {
              logger.error('ERROR', payload.error);
              setStatus(STATUSES.ERROR);
              setFatalError(payload.error.message);
              onFinish({ success: 0, failure: inputFileData.length });
              notifyUser(`Your ${loadType.toLowerCase()} data load failed`, {
                body: `❌ ${payload.error.message}`,
                tag: 'load-records',
              });
              rollbar.error('Error preparing bulk api data', { message: payload.error.message, stack: payload.error.stack });
            } else if (!payload.data.preparedData.data.length) {
              if (payload.data.preparedData.queryErrors?.length) {
                setFatalError(payload.data.preparedData.queryErrors.join('\n'));
              } else if (payload.error) {
                setFatalError(payload.error.message);
              }
              // processing failed on every record
              setStatus(STATUSES.ERROR);
              setPreparedData(payload.data.preparedData);
              setEndTime(dateString);
              // mock response to ensure results table is visible
              setJobInfo({
                concurrencyMode: serialMode ? 'Serial' : 'Parallel',
                contentType: 'CSV',
                createdById: null,
                createdDate: null,
                id: null,
                object: selectedSObject,
                operation: loadType,
                state: 'Failed',
                systemModstamp: null,
                apexProcessingTime: 0,
                apiActiveProcessingTime: 0,
                apiVersion: 0,
                numberBatchesCompleted: 0,
                numberBatchesFailed: 0,
                numberBatchesInProgress: 0,
                numberBatchesQueued: 0,
                numberBatchesTotal: 0,
                numberRecordsFailed: 0,
                numberRecordsProcessed: 0,
                numberRetries: 0,
                totalProcessingTime: 0,
                batches: [],
              });
              onFinish({ success: 0, failure: inputFileData.length });
              notifyUser(`Your ${loadType.toLowerCase()} data load failed`, {
                body: `❌ Pre-processing records failed.`,
                tag: 'load-records',
              });
              rollbar.error('Error preparing bulk api data', {
                queryErrors: payload.data.preparedData.queryErrors,
                message: payload.error?.message,
                stack: payload.error?.stack,
              });
            } else {
              setStatus(STATUSES.UPLOADING);
              setPreparedData(payload.data.preparedData);
              setEndTime(dateString);
            }
            break;
          }
          case 'prepareDataProgress': {
            setPrepareDataProgress(payload.data.progress || 0);
            break;
          }
          case 'loadDataStatus': {
            setBatchSummary(payload.data.resultsSummary);
            if (Array.isArray(payload.data.resultsSummary.jobInfo.batches) && payload.data.resultsSummary.jobInfo.batches.length) {
              setJobInfo(payload.data.resultsSummary.jobInfo);
            }
            break;
          }
          case 'loadData': {
            if (payload.error) {
              logger.error('ERROR', payload.error);
              setFatalError(payload.error.message);
              if (payload.data?.jobInfo && payload.data.jobInfo.batches.length) {
                setJobInfo(payload.data.jobInfo);
                setStatus(STATUSES.PROCESSING);
              } else {
                setStatus(STATUSES.ERROR);
                onFinish({ success: 0, failure: inputFileData.length });
                notifyUser(`Your data load failed`, {
                  body: `❌ ${payload.error?.message || payload.error}`,
                  tag: 'load-records',
                });
              }
              if (payload.error instanceof LoadRecordsBatchError) {
                rollbar.error('Error loading batches', {
                  message: payload.error.message,
                  stack: payload.error.stack,
                  specificErrors: payload.error.additionalErrors.map((error) => ({
                    message: error.message,
                    stack: error.stack,
                  })),
                });
              } else {
                rollbar.error('Error loading batches', { message: payload.error.message, stack: payload.error.stack });
              }
            } else {
              setJobInfo(payload.data.jobInfo);
              setStatus(STATUSES.PROCESSING);
            }
            break;
          }
          default:
            break;
        }
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadWorker]);

  function getUploadingText() {
    if (
      !batchSummary ||
      !(status === STATUSES.UPLOADING || status === STATUSES.PROCESSING) ||
      batchSummary.totalBatches === jobInfo?.batches?.length
    ) {
      return '';
    }
    return `Uploading batch ${batchSummary.batchSummary.filter((item) => item.completed).length + 1} of ${batchSummary.totalBatches}`;
  }

  async function handleSaveHistory() {
    try {
      const historyItems = (await localforage.getItem<MapOf<LoadHistoryItem>>(INDEXED_DB.KEYS.loadHistory)) || {};
      const historyItem: LoadHistoryItem = {
        key: `${selectedOrg.uniqueId}:${preparedData.uuid}`,
        uuid: preparedData.uuid,
        date: new Date(),
        bulkJobId: jobInfo.id,
        resultsDataId: null,
        org: selectedOrg.uniqueId,
        sObject: selectedSObject,
        apiMode,
        operation: loadType,
        batchSize,
        serialMode,
        externalId,
        insertNulls,
        dateFormat,
        assignmentRuleId,
        fieldMapping,
        startTime,
        endTime,
        total: jobInfo.numberRecordsProcessed,
        success: jobInfo.numberRecordsProcessed - jobInfo.numberRecordsFailed,
        failure: jobInfo.numberRecordsFailed,
        errors: preparedData.errors,
      };

      historyItems[historyItem.key] = historyItem;

      await localforage.setItem<MapOf<LoadHistoryItem>>(INDEXED_DB.KEYS.loadHistory, historyItems);
    } catch (ex) {
      logger.warn('Could not save history item', ex);
    }
  }

  async function handleDownloadOrViewRecords(
    action: DownloadAction,
    type: DownloadType,
    batch: BulkJobBatchInfo,
    batchIndex: number
  ): Promise<void> {
    try {
      if (downloadError) {
        setDownloadError(null);
      }
      // download records, combine results from salesforce with actual records, open download modal
      const results = await bulkApiGetRecords<BulkJobResultRecord>(selectedOrg, jobInfo.id, batch.id, 'result');
      // this should match, but will fallback to batchIndex if for some reason we cannot find the batch
      const batchSummaryItem = batchSummary.batchSummary.find((item) => item.id === batch.id);
      const startIdx = (batchSummaryItem?.batchNumber ?? batchIndex) * batchSize;
      /** For delete, only records with a mapped Id will be included in response from SFDC */
      const records: any[] = preparedData.data
        .slice(startIdx, startIdx + batchSize)
        .filter((record) => (loadType !== 'DELETE' ? true : !!record.Id));
      const combinedResults = [];

      results.forEach((resultRecord, i) => {
        // show all if results, otherwise just include errors
        if (type === 'results' || !resultRecord.Success) {
          combinedResults.push({
            _id: resultRecord.Id || records[i].Id || null,
            _success: resultRecord.Success,
            _errors: resultRecord.Error,
            ...records[i],
          });
        }
      });
      logger.log({ combinedResults });
      const header = ['_id', '_success', '_errors'].concat(getFieldHeaderFromMapping(fieldMapping));
      if (action === 'view') {
        setResultsModalData({ ...downloadModalData, open: true, header, data: combinedResults, type });
        trackEvent(ANALYTICS_KEYS.load_DownloadRecords, { loadType, type, numRows: combinedResults.length });
      } else {
        setDownloadModalData({
          ...downloadModalData,
          open: true,
          fileNameParts: [loadType.toLocaleLowerCase(), selectedSObject.toLocaleLowerCase(), type],
          header,
          data: combinedResults,
        });
        trackEvent(ANALYTICS_KEYS.load_ViewRecords, { loadType, type, numRows: combinedResults.length });
      }
    } catch (ex) {
      logger.warn(ex);
      setDownloadError(ex.message);
    }
  }

  function handleDownloadProcessingErrors() {
    const header = ['_id', '_success', '_errors'].concat(getFieldHeaderFromMapping(fieldMapping));
    setDownloadModalData({
      ...downloadModalData,
      open: true,
      fileNameParts: [loadType.toLocaleLowerCase(), selectedSObject.toLocaleLowerCase(), 'processing-failures'],
      header,
      data: preparedData.errors.map((error) => ({
        _id: null,
        _success: false,
        _errors: error.errors.join('\n'),
        ...error.record,
      })),
    });
  }

  function handleDownloadRecordsFromModal(type: 'results' | 'failures', rows: any[]) {
    const fields = getFieldHeaderFromMapping(fieldMapping);
    const header = ['_id', '_success', '_errors'].concat(fields);
    setResultsModalData({ ...resultsModalData, open: false });
    setDownloadModalData({
      open: true,
      data: rows,
      header,
      fileNameParts: [loadType.toLocaleLowerCase(), selectedSObject.toLocaleLowerCase(), type],
    });
    trackEvent(ANALYTICS_KEYS.load_DownloadRecords, { loadType, type, numRows: rows.length, location: 'fromViewModal' });
  }

  function handleModalClose() {
    setDownloadModalData({ ...downloadModalData, open: false, fileNameParts: [] });
  }

  function handleViewModalClose() {
    setResultsModalData({ open: false, data: [], header: [], type: 'results' });
  }
  return (
    <div>
      {downloadModalData.open && (
        <FileDownloadModal
          org={selectedOrg}
          google_apiKey={google_apiKey}
          google_appId={google_appId}
          google_clientId={google_clientId}
          data={downloadModalData.data}
          header={downloadModalData.header}
          fileNameParts={downloadModalData.fileNameParts}
          onModalClose={handleModalClose}
          emitUploadToGoogleEvent={fromJetstreamEvents.emit}
        />
      )}
      {resultsModalData.open && (
        <LoadRecordsResultsModal
          type={resultsModalData.type}
          header={resultsModalData.header}
          rows={resultsModalData.data}
          onDownload={handleDownloadRecordsFromModal}
          onClose={handleViewModalClose}
        />
      )}
      <h3 className="slds-text-heading_small slds-grid">
        <Grid verticalAlign="center">
          <span className="slds-m-right_x-small">
            {status} <span className="slds-text-title">{getUploadingText()}</span>
          </span>
          {status === STATUSES.PREPARING && (
            <div>
              {!!prepareDataProgress && (
                <ProgressRing
                  className="slds-m-right_x-small"
                  fillPercent={prepareDataProgress / 100}
                  size="medium"
                  theme="active-step"
                ></ProgressRing>
              )}
              <div
                css={css`
                  width: 20px;
                  display: inline-block;
                `}
              >
                <Spinner inline containerClassName="slds-m-bottom_small" size="x-small" />
              </div>
            </div>
          )}
        </Grid>
      </h3>
      {fatalError && (
        <div className="slds-text-color_error">
          <strong>Fatal Error</strong>: {fatalError}
        </div>
      )}
      {downloadError && (
        <div className="slds-text-color_error">
          <strong>Error preparing data</strong>: {downloadError}
        </div>
      )}
      {batchSummary && (
        <SalesforceLogin
          serverUrl={serverUrl}
          org={selectedOrg}
          returnUrl={`/lightning/setup/AsyncApiJobStatus/page?address=%2F${batchSummary.jobInfo.id}`}
          iconPosition="right"
        >
          View job in Salesforce
        </SalesforceLogin>
      )}
      {/* Data is being processed */}
      {jobInfo && (
        <LoadRecordsBulkApiResultsTable
          jobInfo={jobInfo}
          processingErrors={preparedData.errors}
          processingStartTime={startTime}
          processingEndTime={endTime}
          onDownloadOrView={handleDownloadOrViewRecords}
          onDownloadProcessingErrors={handleDownloadProcessingErrors}
        />
      )}
    </div>
  );
};

export default LoadRecordsBulkApiResults;
