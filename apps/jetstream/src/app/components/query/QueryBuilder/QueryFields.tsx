import { logger } from '@jetstream/shared/client-logger';
import { fetchFields, getFieldKey } from '@jetstream/shared/ui-utils';
import { multiWordObjectFilter, splitArrayToMaxSize } from '@jetstream/shared/utils';
import { FieldWrapper, MapOf, Maybe, QueryFields, QueryFieldWithPolymorphic } from '@jetstream/types';
import { AutoFullHeightContainer, SobjectFieldList } from '@jetstream/ui';
import isEmpty from 'lodash/isEmpty';
import React, { Fragment, FunctionComponent, useCallback, useEffect, useRef, useState } from 'react';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import { applicationCookieState, selectedOrgState } from '../../../app-state';
import * as fromQueryState from '../query.state';
import {
  getQueryFieldBaseKey,
  getQueryFieldKey,
  getSelectedFieldsFromQueryFields,
  initQueryFieldStateItem,
} from '../utils/query-fields-utils';

export interface QueryFieldsProps {
  selectedSObject: Maybe<string>;
  isTooling: boolean;
  onSelectionChanged: (fields: QueryFieldWithPolymorphic[]) => void;
}

export const QueryFieldsComponent: FunctionComponent<QueryFieldsProps> = ({ selectedSObject, isTooling, onSelectionChanged }) => {
  const [{ serverUrl }] = useRecoilState(applicationCookieState);
  const isMounted = useRef(true);
  const _selectedSObject = useRef(selectedSObject);
  const [queryFieldsMap, setQueryFieldsMap] = useRecoilState(fromQueryState.queryFieldsMapState);
  const [queryFieldsKey, setQueryFieldsKey] = useRecoilState(fromQueryState.queryFieldsKey);
  const setChildRelationships = useSetRecoilState(fromQueryState.queryChildRelationships);
  const [baseKey, setBaseKey] = useState<string>(`${selectedSObject}|`);
  const selectedOrg = useRecoilValue(selectedOrgState);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    _selectedSObject.current = selectedSObject;
  }, [selectedSObject]);

  // Fetch fields for base object if the selected object changes
  useEffect(() => {
    if (!selectedSObject) {
      return;
    }
    const fieldKey = getQueryFieldKey(selectedOrg, selectedSObject);
    if (isEmpty(queryFieldsMap) || fieldKey !== queryFieldsKey) {
      // init query fields when object changes
      let tempQueryFieldsMap: MapOf<QueryFields> = {};
      setQueryFieldsMap(tempQueryFieldsMap);
      if (selectedSObject) {
        const BASE_KEY = getQueryFieldBaseKey(selectedSObject);
        setBaseKey(BASE_KEY);
        tempQueryFieldsMap = { ...tempQueryFieldsMap };
        tempQueryFieldsMap[BASE_KEY] = initQueryFieldStateItem(BASE_KEY, selectedSObject, { loading: true });
        setChildRelationships([]);
        setQueryFieldsMap(tempQueryFieldsMap);
        setQueryFieldsKey(fieldKey);

        queryBaseFields(fieldKey, BASE_KEY, tempQueryFieldsMap);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg, selectedSObject, isTooling]);

  const queryBaseFields = useCallback(
    async (fieldKey: string, BASE_KEY: string, tempQueryFieldsMap: MapOf<QueryFields>) => {
      tempQueryFieldsMap = { ...tempQueryFieldsMap };
      try {
        tempQueryFieldsMap[BASE_KEY] = await fetchFields(selectedOrg, tempQueryFieldsMap[BASE_KEY], BASE_KEY, isTooling);
        if (isMounted.current) {
          // Fetch fields for immediate children
          queryInitialRelatedFields(BASE_KEY, tempQueryFieldsMap[BASE_KEY]);

          tempQueryFieldsMap[BASE_KEY] = { ...tempQueryFieldsMap[BASE_KEY], loading: false };
          setChildRelationships(tempQueryFieldsMap[BASE_KEY].childRelationships || []);
          if (tempQueryFieldsMap[BASE_KEY].fields.Id) {
            tempQueryFieldsMap[BASE_KEY].selectedFields.add('Id');
            emitSelectedFieldsChanged(tempQueryFieldsMap);
          }
        }
      } catch (ex) {
        logger.warn('Query SObject error', ex);
        tempQueryFieldsMap[BASE_KEY] = { ...tempQueryFieldsMap[BASE_KEY], loading: false, hasError: true };
      } finally {
        if (isMounted.current) {
          setQueryFieldsMap(tempQueryFieldsMap);
          setQueryFieldsKey(fieldKey);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedOrg, isTooling]
  );

  /** Fetch one level deep from base object on load - this allows filter fields to include more initial data */
  const queryInitialRelatedFields = useCallback(
    async (parentKey: string, baseField: QueryFields) => {
      try {
        let tempQueryFieldsMap = {};

        // ensure we don't query the same object more than once
        const keysBySobject: Record<string, string[]> = {};

        Object.values(baseField.fields)
          .filter((field) => field.relatedSobject)
          .forEach((field) => {
            const key = getFieldKey(parentKey, field.metadata);

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const relatedSobject = Array.isArray(field.relatedSobject) ? field.relatedSobject[0]! : field.relatedSobject!;

            // this is a new expansion that we have not seen, we need to fetch the fields and init the object
            tempQueryFieldsMap[key] = initQueryFieldStateItem(key, relatedSobject, {
              loading: true,
              expanded: false,
              isPolymorphic: Array.isArray(field.relatedSobject),
            });
            // fetch fields and update once resolved
            keysBySobject[relatedSobject] = keysBySobject[relatedSobject] || [];
            keysBySobject[relatedSobject].push(key);
          });

        // set all as loading
        setQueryFieldsMap((priorValue) => ({ ...priorValue, ...tempQueryFieldsMap }));

        for (const objects of splitArrayToMaxSize(Object.keys(keysBySobject), 3)) {
          const firstKeyForEachObj = objects.map((object) => keysBySobject[object][0]);
          const results = await Promise.all(
            // eslint-disable-next-line no-loop-func
            firstKeyForEachObj.map((key) => fetchFields(selectedOrg, tempQueryFieldsMap[key], key, isTooling))
          );

          let index = 0;
          for (const object of objects) {
            const keys = keysBySobject[object];
            // ensure selected object did not change
            tempQueryFieldsMap = { ...tempQueryFieldsMap, [keys[0]]: { ...results[index], loading: false } };

            // fetch all remaining for object (if there were duplicates) will be cached, so this will be very fast
            if (keys.length > 1) {
              for (const currKey of keys.slice(1)) {
                tempQueryFieldsMap = {
                  ...tempQueryFieldsMap,
                  [currKey]: {
                    ...(await fetchFields(selectedOrg, tempQueryFieldsMap[currKey], currKey, isTooling)),
                    loading: false,
                  },
                };
              }
            }
            index++;
          }
          // Exit if selected object changed or component unmounted
          if (!isMounted.current || baseField.sobject !== _selectedSObject.current) {
            break;
          }
        }

        setQueryFieldsMap((priorValue) => ({ ...priorValue, ...tempQueryFieldsMap }));
      } catch (ex) {
        logger.warn('Error loading related fields', ex);
        // TODO: would this leave anything in a loading state?
        // Should we notify rollbar?
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedOrg, isTooling]
  );

  const queryRelatedFields = useCallback(
    async (fieldKey: string, tempQueryFieldsMap: MapOf<QueryFields>) => {
      try {
        tempQueryFieldsMap[fieldKey] = await fetchFields(selectedOrg, tempQueryFieldsMap[fieldKey], fieldKey, isTooling);
        if (isMounted.current) {
          // ensure selected object did not change
          if (tempQueryFieldsMap[fieldKey]) {
            tempQueryFieldsMap[fieldKey] = { ...tempQueryFieldsMap[fieldKey], loading: false };
            setQueryFieldsMap(tempQueryFieldsMap);
          }
        }
      } catch (ex) {
        logger.warn('Query SObject error', ex);
        tempQueryFieldsMap = { ...tempQueryFieldsMap, [fieldKey]: { ...tempQueryFieldsMap[fieldKey], loading: false, hasError: true } };
      } finally {
        if (isMounted.current) {
          setQueryFieldsMap(tempQueryFieldsMap);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedOrg, isTooling]
  );

  function emitSelectedFieldsChanged(fieldsMap: MapOf<QueryFields> = queryFieldsMap) {
    const fields: QueryFieldWithPolymorphic[] = getSelectedFieldsFromQueryFields(fieldsMap);

    onSelectionChanged(fields);
  }

  async function handleToggleFieldExpand(parentKey: string, field: FieldWrapper, relatedSobject: string) {
    const key = getFieldKey(parentKey, field.metadata);
    // if field is already initialized
    const tempQueryFieldsMap = { ...queryFieldsMap };
    if (tempQueryFieldsMap[key] && tempQueryFieldsMap[key].sobject === relatedSobject) {
      tempQueryFieldsMap[key] = { ...tempQueryFieldsMap[key], expanded: !tempQueryFieldsMap[key].expanded };
    } else {
      // this is a new expansion that we have not seen, we need to fetch the fields and init the object
      tempQueryFieldsMap[key] = initQueryFieldStateItem(key, relatedSobject, {
        loading: true,
        isPolymorphic: Array.isArray(field.relatedSobject),
      });
      // fetch fields and update once resolved
      queryRelatedFields(key, tempQueryFieldsMap);
    }
    setQueryFieldsMap({ ...tempQueryFieldsMap });
  }

  async function handleErrorReattempt(key: string) {
    const tempQueryFieldsMap = { ...queryFieldsMap };
    tempQueryFieldsMap[key] = { ...tempQueryFieldsMap[key], loading: true, hasError: false };
    setQueryFieldsMap({ ...tempQueryFieldsMap });

    queryRelatedFields(key, tempQueryFieldsMap);
  }

  function handleFieldSelection(key: string, field: FieldWrapper) {
    if (queryFieldsMap[key]) {
      const clonedFieldsMapItem = queryFieldsMap[key];
      if (clonedFieldsMapItem.selectedFields.has(field.name)) {
        clonedFieldsMapItem.selectedFields.delete(field.name);
      } else {
        clonedFieldsMapItem.selectedFields.add(field.name);
      }
      setQueryFieldsMap(queryFieldsMap);
      emitSelectedFieldsChanged(queryFieldsMap);
    }
  }

  /**
   * @param key sobject key
   * @param value select all = true/false
   * @param impactedKeys children may have filtered data locally, so keys are passed in to specify the specific fields
   */
  function handleFieldSelectAll(key: string, value: boolean, impactedKeys: string[]) {
    if (queryFieldsMap[key]) {
      const clonedQueryFieldsMap = { ...queryFieldsMap };
      if (value) {
        // keep existing fields and add newly selected fields
        clonedQueryFieldsMap[key] = {
          ...clonedQueryFieldsMap[key],
          selectedFields: new Set(Array.from(clonedQueryFieldsMap[key].selectedFields).concat(impactedKeys)),
        };
      } else {
        // remove visible fields from list (this could be all or only some of the fields)
        const selectedFields = new Set(clonedQueryFieldsMap[key].selectedFields);
        impactedKeys.forEach((field) => selectedFields.delete(field));
        clonedQueryFieldsMap[key] = { ...clonedQueryFieldsMap[key], selectedFields };
      }
      setQueryFieldsMap(clonedQueryFieldsMap);
      emitSelectedFieldsChanged(clonedQueryFieldsMap);
    }
  }

  function handleFieldFilterChanged(key: string, filterTerm: string) {
    if (queryFieldsMap[key] && queryFieldsMap[key].filterTerm !== filterTerm) {
      const clonedQueryFieldsMap = { ...queryFieldsMap };
      const tempQueryField: QueryFields = { ...clonedQueryFieldsMap[key], filterTerm: filterTerm || '' };
      if (!filterTerm) {
        tempQueryField.visibleFields = new Set(Object.keys(tempQueryField.fields));
      } else {
        tempQueryField.visibleFields = new Set(
          Object.values(tempQueryField.fields)
            .filter(
              multiWordObjectFilter(
                ['filterText'],
                filterTerm,
                (field) =>
                  !!field.relationshipKey && queryFieldsMap[field.relationshipKey] && queryFieldsMap[field.relationshipKey].expanded
              )
            )
            .map((field) => field.name)
        );
      }
      clonedQueryFieldsMap[key] = tempQueryField;
      setQueryFieldsMap(clonedQueryFieldsMap);
    }
  }

  function handleOnUnselectAll() {
    const clonedQueryFieldsMap = { ...queryFieldsMap };
    Object.keys(clonedQueryFieldsMap).forEach((key) => {
      clonedQueryFieldsMap[key] = { ...clonedQueryFieldsMap[key], selectedFields: new Set() };
    });
    setQueryFieldsMap(clonedQueryFieldsMap);
    emitSelectedFieldsChanged(clonedQueryFieldsMap);
  }

  return (
    // eslint-disable-next-line react/jsx-no-useless-fragment
    <Fragment>
      {selectedSObject && queryFieldsMap[baseKey] && (
        <AutoFullHeightContainer bottomBuffer={10}>
          <SobjectFieldList
            serverUrl={serverUrl}
            org={selectedOrg}
            isTooling={isTooling}
            level={0}
            itemKey={baseKey}
            queryFieldsMap={queryFieldsMap}
            sobject={selectedSObject}
            errorReattempt={handleErrorReattempt}
            onToggleExpand={handleToggleFieldExpand}
            onSelectField={handleFieldSelection}
            onSelectAll={handleFieldSelectAll}
            onUnselectAll={handleOnUnselectAll}
            onFilterChanged={handleFieldFilterChanged}
          />
        </AutoFullHeightContainer>
      )}
    </Fragment>
  );
};

export default QueryFieldsComponent;
