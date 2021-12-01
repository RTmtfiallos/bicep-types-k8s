// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TypeBuilder } from './typebuilder';
import { Channel } from '@autorest/extension-base';
import { Dictionary, keyBy } from 'lodash';
import { getFullyQualifiedType, ProviderDefinition, ResourceDefinition } from './resources';
import { DiscriminatedObjectType, ObjectProperty, ObjectType, ResourceType, TypeReference } from './types';

export type TypeCallback = (definition: ResourceDefinition, properties: Dictionary<ObjectProperty>) => void;

export abstract class SchemaConverter {
    abstract Convert(builder: TypeBuilder, provider: ProviderDefinition, fullyQualifiedType: string, definitions: ResourceDefinition[]): ResourceType | null;

    protected process(builder: TypeBuilder, provider: ProviderDefinition, fullyQualifiedType: string, definitions: ResourceDefinition[], initializeResource: TypeCallback): ResourceType | null {
        function logWarning(message: string) {
            builder.host.Message({ Channel: Channel.Warning, Text: message, });
        }

        function logInfo(message: string) {
            builder.host.Message({ Channel: Channel.Information, Text: message, });
        }

        function processResource(fullyQualifiedType: string, definitions: ResourceDefinition[]) {
            if (definitions.length > 1) {
                for (const definition of definitions) {
                    if (!definition.descriptor.constantName) {
                        logWarning(`Skipping resource type ${fullyQualifiedType}: Found multiple definitions for the same type`);
                        return null;
                    }
                }

                const definitionsByConstantName = keyBy(definitions, x => x.descriptor.constantName);
                const polymorphicBodies: Dictionary<TypeReference> = {};
                for (const definition of definitions) {
                    const bodyType = processResourceBody(fullyQualifiedType, definition);
                    if (!bodyType || !definition.descriptor.constantName) {
                        return null;
                    }

                    polymorphicBodies[definition.descriptor.constantName] = bodyType;
                }

                const discriminatedBodyType = builder.factory.addType(new DiscriminatedObjectType(
                    fullyQualifiedType,
                    'name',
                    {},
                    polymorphicBodies));

                const descriptor = {
                    ...definitions[0].descriptor,
                    constantName: undefined,
                };

                return {
                    descriptor,
                    bodyType: discriminatedBodyType
                };
            } else {
                const definition = definitions[0];
                const bodyType = processResourceBody(fullyQualifiedType, definition);
                if (!bodyType) {
                    return null;
                }

                return {
                    descriptor: definition.descriptor,
                    bodyType: bodyType,
                };
            }
        }

        function processResourceBody(fullyQualifiedType: string, definition: ResourceDefinition) {
            const { descriptor, schema, } = definition;

            const resourceProperties: Dictionary<ObjectProperty> = {};

            // Call the initialization callback before merging in properties form the schema. This allows the
            // provider to 'own' the definition of critical properties.
            initializeResource(definition, resourceProperties);

            for (const { propertyName, putProperty, getProperty } of builder.getObjectTypeProperties(schema, schema, true)) {
                if (resourceProperties[propertyName]) {
                    continue;
                }

                const propertyDefinition = builder.parseType(putProperty?.schema, getProperty?.schema);
                if (propertyDefinition) {
                    const description = (putProperty?.schema, getProperty?.schema)?.language.default?.description;
                    const flags = builder.parsePropertyFlags(putProperty, getProperty);
                    resourceProperties[propertyName] = builder.createObjectProperty(propertyDefinition, flags, description);
                }
            }

            let resourceDefinition: TypeReference;
            if (schema) {
                resourceDefinition = builder.createObject(getFullyQualifiedType(descriptor), schema, resourceProperties);
            } else {
                logInfo(`Resource type ${fullyQualifiedType} has no body defined.`);
                resourceDefinition = builder.factory.addType(new ObjectType(getFullyQualifiedType(descriptor), resourceProperties));
            }

            if (schema?.discriminator || schema?.discriminator) {
                const discriminatedObjectType = builder.factory.lookupType(resourceDefinition) as DiscriminatedObjectType;

                builder.handlePolymorphicType(discriminatedObjectType, schema, schema);
            }

            return resourceDefinition;
        }

        const result = processResource(fullyQualifiedType, definitions);
        if (!result) {
            return null;
        }

        const resourceType = new ResourceType(`${fullyQualifiedType}@${result.descriptor.apiVersion}`, result.descriptor.scopeType, result.bodyType);
        return resourceType;
    }
}