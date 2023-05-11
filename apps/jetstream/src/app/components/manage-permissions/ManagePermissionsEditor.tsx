import { css } from '@emotion/react';
import { logger } from '@jetstream/shared/client-logger';
import { getMapOf, multiWordObjectFilter } from '@jetstream/shared/utils';
import { MapOf, SalesforceOrgUi } from '@jetstream/types';
import {
  AutoFullHeightContainer,
  ColumnWithFilter,
  ConfirmationModalPromise,
  FileDownloadModal,
  Icon,
  Spinner,
  Tabs,
  Toast,
  Toolbar,
  ToolbarItemActions,
  ToolbarItemGroup,
  Tooltip,
} from '@jetstream/ui';
import { Fragment, FunctionComponent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRecoilState, useRecoilValue, useResetRecoilState } from 'recoil';
import { applicationCookieState, selectedOrgState } from '../../app-state';
import ConfirmPageChange from '../core/ConfirmPageChange';
import { RequireMetadataApiBanner } from '../core/RequireMetadataApiBanner';
import * as fromJetstreamEvents from '../core/jetstream-events';
import ManagePermissionsEditorFieldTable from './ManagePermissionsEditorFieldTable';
import ManagePermissionsEditorObjectTable from './ManagePermissionsEditorObjectTable';
import * as fromPermissionsState from './manage-permissions.state';
import ManagePermissionRecordTypes from './record-types/ManagePermissionRecordTypes';
import { usePermissionRecordTypes } from './usePermissionRecordTypes';
import { usePermissionRecords } from './usePermissionRecords';
import { generateExcelWorkbookFromTable } from './utils/permission-manager-export-utils';
import {
  getConfirmationModalContent,
  getDirtyFieldPermissions,
  getDirtyObjectPermissions,
  getFieldColumns,
  getFieldRows,
  getObjectColumns,
  getObjectRows,
  getTableDataForRecordTypes,
  updateFieldRowsAfterSave,
  updateObjectRowsAfterSave,
} from './utils/permission-manager-table-utils';
import {
  DirtyRow,
  FieldPermissionDefinitionMap,
  FieldPermissionRecordForSave,
  ManagePermissionsEditorTableRef,
  ObjectPermissionDefinitionMap,
  ObjectPermissionRecordForSave,
  PermissionFieldSaveData,
  PermissionManagerObjectWithRecordType,
  PermissionManagerRecordTypeRow,
  PermissionObjectSaveData,
  PermissionSaveResults,
  PermissionTableFieldCell,
  PermissionTableFieldCellPermission,
  PermissionTableObjectCell,
  PermissionTableObjectCellPermission,
  PermissionTableSummaryRow,
} from './utils/permission-manager-types';
import {
  clearPermissionErrorMessage,
  collectProfileAndPermissionIds,
  getUpdatedFieldPermissions,
  getUpdatedObjectPermissions,
  permissionsHaveError,
  prepareFieldPermissionSaveData,
  prepareObjectPermissionSaveData,
  savePermissionRecords,
  updatePermissionSetRecords,
} from './utils/permission-manager-utils';

const HEIGHT_BUFFER = 170;

export function ErrorTooltip({ hasError, id }: { hasError: boolean; id: string }) {
  if (!hasError) {
    return null;
  }
  return (
    <Tooltip
      id={`tooltip-${id}`}
      content={
        <div>
          <strong>There were errors saving your data, review the table for more information.</strong>
        </div>
      }
    >
      <Icon type="utility" icon="error" className="slds-icon slds-icon-text-error slds-icon_xx-small slds-m-left_small" />
    </Tooltip>
  );
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ManagePermissionsEditorProps {}

export const ManagePermissionsEditor: FunctionComponent<ManagePermissionsEditorProps> = () => {
  const isMounted = useRef(true);
  const [{ google_apiKey, google_appId, google_clientId }] = useRecoilState(applicationCookieState);
  const managePermissionsEditorObjectTableRef = useRef<ManagePermissionsEditorTableRef>();
  const managePermissionsEditorFieldTableRef = useRef<ManagePermissionsEditorTableRef>();
  const selectedOrg = useRecoilValue<SalesforceOrgUi>(selectedOrgState);

  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [fileDownloadModalOpen, setFileDownloadModalOpen] = useState<boolean>(false);
  const [fileDownloadData, setFileDownloadData] = useState<ArrayBuffer | null>(null);

  const selectedProfiles = useRecoilValue(fromPermissionsState.selectedProfilesPermSetState);
  const selectedPermissionSets = useRecoilValue(fromPermissionsState.selectedPermissionSetsState);
  const selectedSObjects = useRecoilValue(fromPermissionsState.selectedSObjectsState);

  const profilesById = useRecoilValue(fromPermissionsState.profilesByIdSelector);
  const permissionSetsById = useRecoilValue(fromPermissionsState.permissionSetsByIdSelector);

  const selectedProfileRecords = useRecoilValue(fromPermissionsState.selectedProfilesSelector);

  const [fieldsByObject, setFieldsByObject] = useRecoilState(fromPermissionsState.fieldsByObject);
  const [fieldsByKey, setFieldsByKey] = useRecoilState(fromPermissionsState.fieldsByKey);
  const [objectPermissionMap, setObjectPermissionMap] = useRecoilState(fromPermissionsState.objectPermissionMap);
  const [fieldPermissionMap, setFieldPermissionMap] = useRecoilState(fromPermissionsState.fieldPermissionMap);
  const resetFieldsByObject = useResetRecoilState(fromPermissionsState.fieldsByObject);
  const resetFieldsByKey = useResetRecoilState(fromPermissionsState.fieldsByKey);
  const resetObjectPermissionMap = useResetRecoilState(fromPermissionsState.objectPermissionMap);
  const resetFieldPermissionMap = useResetRecoilState(fromPermissionsState.fieldPermissionMap);

  const recordData = usePermissionRecords(selectedOrg, selectedSObjects, selectedProfiles, selectedPermissionSets);
  const recordTypeData = usePermissionRecordTypes(selectedOrg, selectedSObjects, selectedProfileRecords);

  const [objectColumns, setObjectColumns] = useState<ColumnWithFilter<PermissionTableObjectCell, PermissionTableSummaryRow>[]>([]);
  const [objectRows, setObjectRows] = useState<PermissionTableObjectCell[] | null>(null);
  const [visibleObjectRows, setVisibleObjectRows] = useState<PermissionTableObjectCell[] | null>(null);
  const [dirtyObjectRows, setDirtyObjectRows] = useState<MapOf<DirtyRow<PermissionTableObjectCell>>>({});
  const [objectFilter, setObjectFilter] = useState('');

  const [fieldColumns, setFieldColumns] = useState<ColumnWithFilter<PermissionTableFieldCell, PermissionTableSummaryRow>[]>([]);
  const [fieldRows, setFieldRows] = useState<PermissionTableFieldCell[] | null>(null);
  const [visibleFieldRows, setVisibleFieldRows] = useState<PermissionTableFieldCell[] | null>(null);
  const [dirtyFieldRows, setDirtyFieldRows] = useState<MapOf<DirtyRow<PermissionTableFieldCell>>>({});
  const [fieldFilter, setFieldFilter] = useState('');

  const [recordTypeColumns, setRecordTypeColumns] = useState<ColumnWithFilter<PermissionManagerRecordTypeRow, PermissionTableSummaryRow>[]>(
    []
  );
  const [recordTypeRows, setRecordTypeRows] = useState<PermissionManagerRecordTypeRow[] | null>(null);
  // const [visibleObjectRows, setVisibleObjectRows] = useState<PermissionManagerRecordTypeRow[] | null>(null);
  const [dirtyRecordTypeRows, setDirtyRecordTypeRows] = useState<MapOf<DirtyRow<PermissionManagerRecordTypeRow>>>({});
  // const [objectFilter, setObjectFilter] = useState('');

  const [dirtyObjectCount, setDirtyObjectCount] = useState<number>(0);
  const [dirtyFieldCount, setDirtyFieldCount] = useState<number>(0);
  const [dirtyRecordTypeCount, setDirtyRecordTypeCount] = useState<number>(0);

  const [objectsHaveErrors, setObjectsHaveErrors] = useState<boolean>(false);
  const [fieldsHaveErrors, setFieldsHaveErrors] = useState<boolean>(false);
  const [recordTypesHaveErrors, setRecordTypesHaveErrors] = useState<boolean>(false);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    setFieldsByObject(recordData.fieldsByObject);
    setFieldsByKey(recordData.fieldsByKey);
    setObjectPermissionMap(recordData.objectPermissionMap);
    setFieldPermissionMap(recordData.fieldPermissionMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordData.fieldsByObject, recordData.fieldsByKey, recordData.objectPermissionMap, recordData.fieldPermissionMap]);

  useEffect(() => {
    recordTypeData.recordTypeData && initRecordTypeData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordTypeData.recordTypeData]);

  useEffect(() => {
    setLoading(recordData.loading);
  }, [recordData.loading]);

  useEffect(() => {
    if (!loading && !hasLoaded && fieldsByObject && fieldsByKey && objectPermissionMap && fieldPermissionMap) {
      setHasLoaded(true);
      initTableData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, fieldsByObject, fieldsByKey, objectPermissionMap, fieldPermissionMap]);

  useEffect(() => {
    setHasError(recordData.hasError);
  }, [recordData.hasError]);

  useEffect(() => {
    if (objectPermissionMap && fieldPermissionMap) {
      setObjectsHaveErrors(permissionsHaveError(objectPermissionMap));
      setFieldsHaveErrors(permissionsHaveError(fieldPermissionMap));
    }
  }, [objectPermissionMap, fieldPermissionMap]);

  useEffect(() => {
    setDirtyFieldCount(Object.values(dirtyFieldRows).reduce((output, { dirtyCount }) => output + dirtyCount, 0));
  }, [dirtyFieldRows]);

  useEffect(() => {
    setDirtyObjectCount(Object.values(dirtyObjectRows).reduce((output, { dirtyCount }) => output + dirtyCount, 0));
  }, [dirtyObjectRows]);

  useEffect(() => {
    setDirtyRecordTypeCount(Object.values(dirtyRecordTypeRows).reduce((output, { dirtyCount }) => output + dirtyCount, 0));
  }, [dirtyRecordTypeRows]);

  useEffect(() => {
    if (fieldRows && fieldFilter) {
      setVisibleFieldRows(fieldRows.filter(multiWordObjectFilter(['label', 'apiName'], fieldFilter)));
    } else {
      setVisibleFieldRows(fieldRows);
    }
  }, [fieldFilter, fieldRows]);

  useEffect(() => {
    if (objectRows && objectFilter) {
      setVisibleObjectRows(objectRows.filter(multiWordObjectFilter(['label', 'apiName'], objectFilter)));
    } else {
      setVisibleObjectRows(objectRows);
    }
  }, [objectFilter, objectRows]);

  const handleObjectBulkRowUpdate = useCallback((rows: PermissionTableObjectCell[], indexes?: number[]) => {
    const rowsByKey = getMapOf(rows, 'key');
    setObjectRows((prevRows) => (prevRows ? prevRows?.map((row) => rowsByKey[row.key] || row) : rows));
    indexes = indexes || rows.map((row, index) => index);
    setDirtyObjectRows((priorValue) => {
      const newValues = { ...priorValue };
      indexes?.forEach((rowIndex) => {
        const row = rows[rowIndex];
        const rowKey = row.key; // e.x. Obj__c.Field__c
        const dirtyCount = Object.values(row.permissions).reduce(
          (output, { createIsDirty, readIsDirty, editIsDirty, deleteIsDirty, viewAllIsDirty, modifyAllIsDirty }) => {
            output += createIsDirty ? 1 : 0;
            output += readIsDirty ? 1 : 0;
            output += editIsDirty ? 1 : 0;
            output += deleteIsDirty ? 1 : 0;
            output += viewAllIsDirty ? 1 : 0;
            output += modifyAllIsDirty ? 1 : 0;
            return output;
          },
          0
        );
        newValues[rowKey] = { rowKey, dirtyCount, row };
      });
      // remove items with a dirtyCount of 0 to reduce future processing required
      return Object.keys(newValues).reduce((output: MapOf<DirtyRow<PermissionTableObjectCell>>, key) => {
        if (newValues[key].dirtyCount) {
          output[key] = newValues[key];
        }
        return output;
      }, {});
    });
  }, []);

  const handleFieldBulkRowUpdate = useCallback((rows: PermissionTableFieldCell[], indexes?: number[]) => {
    const rowsByKey = getMapOf(rows, 'key');
    setFieldRows((prevRows) => (prevRows ? prevRows?.map((row) => rowsByKey[row.key] || row) : rows));
    indexes = indexes || rows.map((row, index) => index);
    setDirtyFieldRows((priorValue) => {
      const newValues = { ...priorValue };
      indexes?.forEach((rowIndex) => {
        const row = rows[rowIndex];
        const rowKey = row.key; // e.x. Obj__c.Field__c
        const dirtyCount = Object.values(row.permissions).reduce((output, { readIsDirty, editIsDirty }) => {
          output += readIsDirty ? 1 : 0;
          output += editIsDirty ? 1 : 0;
          return output;
        }, 0);
        newValues[rowKey] = { rowKey, dirtyCount, row };
      });
      // remove items with a dirtyCount of 0 to reduce future processing required
      return Object.keys(newValues).reduce((output: MapOf<DirtyRow<PermissionTableFieldCell>>, key) => {
        if (newValues[key].dirtyCount) {
          output[key] = newValues[key];
        }
        return output;
      }, {});
    });
  }, []);

  const handleRecordTypeBulkRowUpdate = useCallback((rows: PermissionManagerRecordTypeRow[], indexes?: number[]) => {
    const rowsByKey = getMapOf(rows, 'key');
    setRecordTypeRows((prevRows) => (prevRows ? prevRows?.map((row) => rowsByKey[row.key] || row) : rows));
    indexes = indexes || rows.map((row, index) => index);
    const keysToCompare: (keyof PermissionManagerObjectWithRecordType)[] = ['default', 'layoutName', 'visible'];
    setDirtyRecordTypeRows((priorValue) => {
      const newValues = { ...priorValue };
      indexes?.forEach((rowIndex) => {
        const row = rows[rowIndex];
        const rowKey = row.key;
        const dirtyCount = Object.keys(row.permissions).reduce((acc, profileName) => {
          const currValue: PermissionManagerObjectWithRecordType = row.permissions[profileName];
          const origValue: PermissionManagerObjectWithRecordType = row.permissionsOriginal[profileName];
          keysToCompare.forEach((key) => {
            if (currValue[key] !== origValue[key]) {
              acc += 1;
            }
          });
          return acc;
        }, 0);
        newValues[rowKey] = { rowKey, dirtyCount, row };
      });
      // remove items with a dirtyCount of 0 to reduce future processing required
      return Object.keys(newValues).reduce((output: MapOf<DirtyRow<PermissionManagerRecordTypeRow>>, key) => {
        if (newValues[key].dirtyCount) {
          output[key] = newValues[key];
        }
        return output;
      }, {});
    });
  }, []);

  function initTableData(
    includeColumns = true,
    objectPermissionMapOverride?: MapOf<ObjectPermissionDefinitionMap>,
    fieldPermissionMapOverride?: MapOf<FieldPermissionDefinitionMap>
  ) {
    if (includeColumns) {
      setObjectColumns(getObjectColumns(selectedProfiles, selectedPermissionSets, profilesById, permissionSetsById));
      setFieldColumns(getFieldColumns(selectedProfiles, selectedPermissionSets, profilesById, permissionSetsById));
    }
    const tempObjectRows = getObjectRows(selectedSObjects, objectPermissionMapOverride || objectPermissionMap || {});
    setObjectRows(tempObjectRows);
    setVisibleObjectRows(tempObjectRows);
    setDirtyObjectRows({});

    const tempFieldRows = getFieldRows(selectedSObjects, fieldsByObject || {}, fieldPermissionMapOverride || fieldPermissionMap || {});
    setFieldRows(tempFieldRows);
    setVisibleFieldRows(tempFieldRows);
    setDirtyFieldRows({});
  }

  function initRecordTypeData(includeColumns = true) {
    if (recordTypeData.recordTypeData) {
      const { columns, rows } = getTableDataForRecordTypes(recordTypeData.recordTypeData);
      setRecordTypeColumns(columns);
      setRecordTypeRows(rows);
      setDirtyRecordTypeRows({});
      // TODO figure out what else we need to store
    }

    if (includeColumns) {
      setObjectColumns(getObjectColumns(selectedProfiles, selectedPermissionSets, profilesById, permissionSetsById));
      setFieldColumns(getFieldColumns(selectedProfiles, selectedPermissionSets, profilesById, permissionSetsById));
    }
  }

  function exportChanges() {
    // generate brand-new columns/rows just for export
    // This is required in the case where a tab may not have been rendered
    setFileDownloadData(
      generateExcelWorkbookFromTable(
        {
          columns: getObjectColumns(selectedProfiles, selectedPermissionSets, profilesById, permissionSetsById),
          rows: getObjectRows(selectedSObjects, objectPermissionMap || {}),
        },
        {
          columns: getFieldColumns(selectedProfiles, selectedPermissionSets, profilesById, permissionSetsById),
          rows: getFieldRows(selectedSObjects, fieldsByObject || {}, fieldPermissionMap || {}),
        }
      )
    );
    setFileDownloadModalOpen(true);
  }

  async function saveChanges() {
    if (
      await ConfirmationModalPromise({
        header: 'Confirmation',
        confirm: 'Save Changes',
        content: getConfirmationModalContent(dirtyObjectCount, dirtyFieldCount),
      })
    ) {
      setLoading(true);
      let objectPermissionData: PermissionObjectSaveData | undefined = undefined;
      let fieldPermissionData: PermissionFieldSaveData | undefined = undefined;
      let profileIds: string[] = [];
      let permissionSetIds: string[] = [];

      if (dirtyObjectCount) {
        const dirtyPermissions = getDirtyObjectPermissions(dirtyObjectRows);
        if (dirtyPermissions.length > 0) {
          objectPermissionData = prepareObjectPermissionSaveData(dirtyPermissions);
          const ids = collectProfileAndPermissionIds(dirtyPermissions, profilesById, permissionSetsById);
          profileIds = [...profileIds, ...ids.profileIds];
          permissionSetIds = [...permissionSetIds, ...ids.permissionSetIds];
        }
      }
      if (dirtyFieldCount) {
        const dirtyPermissions = getDirtyFieldPermissions(dirtyFieldRows);
        if (dirtyPermissions.length > 0) {
          fieldPermissionData = prepareFieldPermissionSaveData(dirtyPermissions);
          const ids = collectProfileAndPermissionIds(dirtyPermissions, profilesById, permissionSetsById);
          profileIds = [...profileIds, ...ids.profileIds];
          permissionSetIds = [...permissionSetIds, ...ids.permissionSetIds];
        }
      }

      let objectSaveResults: PermissionSaveResults<ObjectPermissionRecordForSave, PermissionTableObjectCellPermission>[] | undefined =
        undefined;
      let fieldSaveResults: PermissionSaveResults<FieldPermissionRecordForSave, PermissionTableFieldCellPermission>[] | undefined =
        undefined;

      if (objectPermissionData) {
        objectSaveResults = await savePermissionRecords<ObjectPermissionRecordForSave, PermissionTableObjectCellPermission>(
          selectedOrg,
          'ObjectPermissions',
          objectPermissionData
        );
        logger.log({ objectSaveResults });
      }
      if (fieldPermissionData) {
        fieldSaveResults = await savePermissionRecords<FieldPermissionRecordForSave, PermissionTableFieldCellPermission>(
          selectedOrg,
          'FieldPermissions',
          fieldPermissionData
        );
        logger.log({ fieldSaveResults });
      }

      // Update records so that SFDX is aware of the changes
      try {
        await updatePermissionSetRecords(selectedOrg, {
          permissionSetIds: Array.from(permissionSetIds),
          profileIds: Array.from(profileIds),
        });
      } catch (ex) {
        logger.error('Error flagging permissions sets as updated', ex);
      }

      if (isMounted.current) {
        if (objectSaveResults && objectPermissionMap && objectRows) {
          const permissionsMap = getUpdatedObjectPermissions(objectPermissionMap, objectSaveResults);
          const rows = updateObjectRowsAfterSave(objectRows, permissionsMap);
          setObjectPermissionMap(permissionsMap);
          setObjectRows(rows);
          handleObjectBulkRowUpdate(rows);
        }
        if (fieldSaveResults && fieldPermissionMap && fieldRows) {
          const permissionsMap = getUpdatedFieldPermissions(fieldPermissionMap, fieldSaveResults);
          const rows = updateFieldRowsAfterSave(fieldRows, permissionsMap);
          setFieldPermissionMap(permissionsMap);
          setFieldRows(rows);
          handleFieldBulkRowUpdate(rows);
        }
        setLoading(false);
      }
    }
  }

  function resetChanges() {
    const updatedObjectPermissionMap = clearPermissionErrorMessage(objectPermissionMap || {});
    const updatedFieldPermissionMap = clearPermissionErrorMessage(fieldPermissionMap || {});
    setObjectPermissionMap(updatedObjectPermissionMap);
    setFieldPermissionMap(updatedFieldPermissionMap);
    initTableData(false, updatedObjectPermissionMap, updatedFieldPermissionMap);
  }

  function handleGoBack() {
    resetFieldsByObject();
    resetFieldsByKey();
    resetObjectPermissionMap();
    resetFieldPermissionMap();
  }

  return (
    <div>
      <ConfirmPageChange actionInProgress={loading} />
      {fileDownloadData && fileDownloadModalOpen && (
        <FileDownloadModal
          org={selectedOrg}
          google_apiKey={google_apiKey}
          google_appId={google_appId}
          google_clientId={google_clientId}
          data={fileDownloadData}
          fileNameParts={['permissions', 'export']}
          allowedTypes={['xlsx']}
          onModalClose={() => setFileDownloadModalOpen(false)}
          emitUploadToGoogleEvent={fromJetstreamEvents.emit}
        />
      )}
      <RequireMetadataApiBanner />
      <Toolbar>
        <ToolbarItemGroup>
          <Link className="slds-button slds-button_brand" to=".." onClick={handleGoBack}>
            <Icon type="utility" icon="back" className="slds-button__icon slds-button__icon_left" omitContainer />
            Go Back
          </Link>
        </ToolbarItemGroup>
        <ToolbarItemActions>
          <button
            className="slds-button slds-button_neutral collapsible-button collapsible-button-xs"
            onClick={resetChanges}
            title="Reset Changes"
            disabled={loading || (!dirtyObjectCount && !dirtyFieldCount && !objectsHaveErrors && !fieldsHaveErrors)}
          >
            <Icon type="utility" icon="refresh" className="slds-button__icon slds-button__icon_left" />
            <span>Reset Changes</span>
          </button>
          <button
            className="slds-button slds-button_neutral collapsible-button collapsible-button-xs"
            onClick={exportChanges}
            disabled={loading || hasError}
            title="Export"
          >
            <Icon type="utility" icon="download" className="slds-button__icon slds-button__icon_left" />
            <span>Export</span>
          </button>
          <button
            className="slds-button slds-button_brand"
            onClick={saveChanges}
            disabled={loading || (!dirtyObjectCount && !dirtyFieldCount)}
          >
            <Icon type="utility" icon="upload" className="slds-button__icon slds-button__icon_left" />
            Save
          </button>
        </ToolbarItemActions>
      </Toolbar>
      <AutoFullHeightContainer
        baseCss={css`
          background-color: #ffffff;
        `}
        bottomBuffer={10}
        className="slds-scrollable_none"
        bufferIfNotRendered={HEIGHT_BUFFER}
      >
        {loading && <Spinner />}
        {hasError && <Toast type="error">Uh Oh. There was a problem getting the permission data from Salesforce.</Toast>}
        {hasLoaded && (
          <Tabs
            initialActiveId="field-permissions"
            tabs={[
              {
                id: 'object-permissions',
                title: (
                  <Fragment>
                    <span className="slds-tabs__left-icon">
                      <Icon
                        type="standard"
                        icon="entity"
                        containerClassname="slds-icon_container slds-icon-standard-entity"
                        className="slds-icon slds-icon_small"
                      />
                    </span>
                    Object Permissions {dirtyObjectCount ? `(${dirtyObjectCount})` : ''}
                    <ErrorTooltip hasError={objectsHaveErrors} id="object-errors" />
                  </Fragment>
                ),
                titleText: 'Object Permissions',
                disabled: true,
                content: (
                  <ManagePermissionsEditorObjectTable
                    ref={managePermissionsEditorObjectTableRef}
                    columns={objectColumns}
                    rows={visibleObjectRows || []}
                    totalCount={objectRows?.length || 0}
                    onFilter={setObjectFilter}
                    onBulkUpdate={handleObjectBulkRowUpdate}
                    onDirtyRows={setDirtyObjectRows}
                  />
                ),
              },
              {
                id: 'field-permissions',
                title: (
                  <Fragment>
                    <span className="slds-tabs__left-icon">
                      <Icon
                        type="standard"
                        icon="multi_picklist"
                        containerClassname="slds-icon_container slds-icon-standard-multi-picklist"
                        className="slds-icon slds-icon_small"
                      />
                    </span>
                    Field Permissions {dirtyFieldCount ? `(${dirtyFieldCount})` : ''}
                    <ErrorTooltip hasError={fieldsHaveErrors} id="field-errors" />
                  </Fragment>
                ),
                titleText: 'Field Permissions',
                content: (
                  <ManagePermissionsEditorFieldTable
                    ref={managePermissionsEditorFieldTableRef}
                    columns={fieldColumns}
                    rows={visibleFieldRows || []}
                    totalCount={fieldRows?.length || 0}
                    onFilter={setFieldFilter}
                    onBulkUpdate={handleFieldBulkRowUpdate}
                    onDirtyRows={setDirtyFieldRows}
                  />
                ),
              },
              {
                id: 'record-types',
                title: (
                  <Fragment>
                    {recordTypeData.loading && <Spinner size="small" />}
                    <span className="slds-tabs__left-icon">
                      <Icon
                        type="standard"
                        icon="record"
                        containerClassname="slds-icon_container slds-icon-standard-record"
                        className="slds-icon slds-icon_small"
                      />
                    </span>
                    Record Types {dirtyRecordTypeCount ? `(${dirtyRecordTypeCount})` : ''}
                    {/* <ErrorTooltip hasError={fieldsHaveErrors} id="record-type-errors" /> */}
                  </Fragment>
                ),
                titleText: 'Record Types',
                content: (
                  <>
                    {recordTypeData.loading && <Spinner size="small" />}
                    {!recordTypeData.loading && recordTypeData.recordTypeData && (
                      <ManagePermissionRecordTypes
                        columns={recordTypeColumns}
                        rows={recordTypeRows || []}
                        onBulkUpdate={handleRecordTypeBulkRowUpdate}
                        loading={recordTypeData.loading}
                        hasError={recordTypeData.hasError}
                      />
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </AutoFullHeightContainer>
    </div>
  );
};

export default ManagePermissionsEditor;
