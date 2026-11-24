# Third-party notices

The mindmodel Java engine (`engine-java/`) is distributed as a shaded jar that contains the libraries below.
The engine's own code is MIT, like the rest of mindmodel.

## Spoon

- Module: `fr.inria.gforge.spoon:spoon-core` 11.5.0
- Licence: MIT OR CeCILL-C (dual)
- Copyright: Inria and contributors
- Project: https://github.com/INRIA/spoon

## Eclipse JDT (Core)

Spoon's Java front end is the Eclipse Java compiler from Eclipse JDT Core.

- Module: `org.eclipse.jdt:org.eclipse.jdt.core`
- Licence: Eclipse Public License 2.0 (EPL-2.0)
- Copyright: Eclipse Foundation and contributors
- Project: https://github.com/eclipse-jdt/eclipse.jdt.core

The EPL-2.0 applies to JDT and to source code in this jar under JDT's namespace (`org/eclipse/jdt/**`). That part is
made available under the EPL-2.0; the rest of the jar stays under MIT. JDT's source is available from the project
above, as EPL-2.0 requires.

## Jackson Core

- Module: `com.fasterxml.jackson.core:jackson-core` 2.17.2
- Licence: Apache License 2.0
- Copyright: FasterXML, LLC
- Project: https://github.com/FasterXML/jackson-core

Spoon also brings `jackson-databind` and `jackson-annotations`; the shaded jar keeps its own `jackson-core` 2.17.2
as the direct dependency. Spoon's only use of databind is in its test utilities, which the engine never calls.

## Other libraries in the jar

Spoon's own dependencies are shaded too: `org.slf4j:slf4j-api` (MIT), `commons-io:commons-io`,
`org.apache.commons:commons-lang3`, `org.apache.commons:commons-compress`, `commons-codec:commons-codec`,
`org.apache.maven:maven-model`, `org.apache.maven:maven-invoker`, `org.apache.maven.shared:maven-shared-utils`,
`org.codehaus.plexus:plexus-utils`, `org.jspecify:jspecify` (all Apache-2.0), and `com.martiansoftware:jsap`.
Each keeps its own licence and copyright; the full list is the dependency tree of `engine-java/pom.xml`.

## Test-only

JUnit Jupiter 5.10.2 (Eclipse Public License 2.0) is a test dependency and is not included in the shaded jar.
