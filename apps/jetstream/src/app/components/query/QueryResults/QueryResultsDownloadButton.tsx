import { QueryResultsColumn } from '@jetstream/api-interfaces';
import { ANALYTICS_KEYS } from '@jetstream/shared/constants';
import { AsyncJobNew, BulkDownloadJob, FileExtCsvXLSXJsonGSheet, MapOf, Maybe, SalesforceOrgUi } from '@jetstream/types';
import { DownloadFromServerOpts, Icon, RecordDownloadModal } from '@jetstream/ui';
import { Fragment, FunctionComponent, useState } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { applicationCookieState } from '../../../app-state';
import { useAmplitude } from '../../core/analytics';
import * as fromJetstreamEvents from '../../core/jetstream-events';
import * as fromQueryState from '../query.state';

export interface QueryResultsDownloadButtonProps {
  selectedOrg: SalesforceOrgUi;
  sObject?: Maybe<string>;
  soql: string;
  columns?: QueryResultsColumn[];
  disabled: boolean;
  isTooling: boolean;
  nextRecordsUrl: Maybe<string>;
  fields: string[];
  modifiedFields: string[];
  subqueryFields: Maybe<MapOf<string[]>>;
  records: any[];
  filteredRows: any[];
  selectedRows: any[];
  totalRecordCount: number;
}

export const QueryResultsDownloadButton: FunctionComponent<QueryResultsDownloadButtonProps> = ({
  selectedOrg,
  sObject,
  soql,
  columns,
  disabled,
  isTooling,
  nextRecordsUrl,
  fields,
  modifiedFields,
  subqueryFields,
  records,
  filteredRows,
  selectedRows,
  totalRecordCount,
}) => {
  const { trackEvent } = useAmplitude();
  const [{ google_apiKey, google_appId, google_clientId, serverUrl }] = useRecoilState(applicationCookieState);
  const [isDownloadModalOpen, setModalOpen] = useState<boolean>(false);
  const includeDeletedRecords = useRecoilValue(fromQueryState.queryIncludeDeletedRecordsState);

  function handleDidDownload(fileFormat: FileExtCsvXLSXJsonGSheet, whichFields: 'all' | 'specified', includeSubquery: boolean) {
    trackEvent(ANALYTICS_KEYS.query_DownloadResults, {
      source: 'BROWSER',
      fileFormat,
      isTooling,
      userOverrideFields: whichFields === 'specified',
      whichFields,
      includeSubquery,
    });
  }

  function handleDownloadFromServer(options: DownloadFromServerOpts) {
    const {
      fileFormat,
      fileName,
      fields,
      includeSubquery,
      whichFields,
      recordsToInclude,
      hasAllRecords,
      googleFolder,
      includeDeletedRecords,
      useBulkApi,
    } = options;
    const jobs: AsyncJobNew<BulkDownloadJob>[] = [
      {
        type: 'BulkDownload',
        title: `Download Records`,
        org: selectedOrg,
        meta: {
          serverUrl,
          sObject: sObject || '',
          soql,
          isTooling,
          includeDeletedRecords,
          useBulkApi,
          fields,
          subqueryFields,
          records: recordsToInclude || records || [],
          totalRecordCount: totalRecordCount || 0,
          nextRecordsUrl,
          hasAllRecords,
          fileFormat,
          fileName,
          includeSubquery,
          googleFolder,
        },
      },
    ];
    fromJetstreamEvents.emit({ type: 'newJob', payload: jobs });
    trackEvent(ANALYTICS_KEYS.query_DownloadResults, {
      source: 'SERVER',
      fileFormat,
      isTooling,
      userOverrideFields: whichFields === 'specified',
      includeSubquery,
    });
  }

  return (
    <Fragment>
      <button className="slds-button slds-button_brand" onClick={() => setModalOpen(true)} disabled={disabled}>
        <Icon type="utility" icon="download" className="slds-button__icon slds-button__icon_left" omitContainer />
        Download
      </button>
      {isDownloadModalOpen && (
        <RecordDownloadModal
          org={selectedOrg}
          google_apiKey={google_apiKey}
          google_appId={google_appId}
          google_clientId={google_clientId}
          downloadModalOpen={isDownloadModalOpen}
          columns={columns}
          fields={fields || []}
          modifiedFields={modifiedFields || []}
          subqueryFields={subqueryFields || {}}
          records={records || []}
          filteredRecords={filteredRows}
          selectedRecords={selectedRows}
          totalRecordCount={totalRecordCount || 0}
          onModalClose={() => setModalOpen(false)}
          onDownload={handleDidDownload}
          includeDeletedRecords={includeDeletedRecords}
          onDownloadFromServer={handleDownloadFromServer}
        />
      )}
    </Fragment>
  );
};

export default QueryResultsDownloadButton;
