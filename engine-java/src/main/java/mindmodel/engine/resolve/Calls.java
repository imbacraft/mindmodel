package mindmodel.engine.resolve;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtSuperAccess;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtRecordComponent;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.RecordCtors;
import mindmodel.engine.model.Walk;

/**
 * What a call, a method reference or a `new` reaches, and what its receiver is. A target is named only when its
 * declaration is in this checkout: the dump never guesses a library's answer, and it never names the class a call is
 * written in for a receiver it cannot type. The declaration is {@code declared}; each implementation in a subtype is
 * {@code override}. Which of them a reader follows is policy, and lives in Node.
 */
public final class Calls {

    /** One target of a call: the declaration Spoon resolved, or an override of it in a subtype declared here. */
    public record Target(String id, String kind) {
    }

    /**
     * A receiver, judged: its type when the checkout declares it, whether it is a builder Lombok invented, whether
     * Spoon invented the name (an invented receiver has no type the dump may give), and whether it is a Lombok field.
     */
    public record Recv(String type, boolean declared, boolean builder, boolean invented, boolean generatedField) {
    }

    /**
     * The declarations of the dumped types and their relations. {@code byShape} and {@code byArity} are keyed by owner,
     * then by {@code name/argc}; {@code bound} is {@code owner#T -> bound fqn}, only where every subtype that names the
     * type writes the same argument.
     */
    private record Index(Map<String, CtType<?>> types, Set<String> declared, Map<String, Set<String>> subtypes,
            Map<String, Set<String>> supertypes, Map<String, Map<String, String>> byShape,
            Map<String, Map<String, String>> byArity, Map<String, String> bound) {
    }

    private final Index index;
    private final Lombok.Index generated;
    private final Chains chains;
    private final Failures failures;

    /**
     * The resolver over the dumped types. {@code known} adds the generated sources' signatures, which the index needs
     * so a call into a generated mapper is typed like any other; they are never walked.
     */
    public Calls(List<CtType<?>> known, Lombok.Index generated, Chains chains, Failures failures) {
        this.index = index(known, failures);
        this.generated = generated;
        this.chains = chains;
        this.failures = failures;
    }

    /** The Lombok members the run synthesised. */
    public Lombok.Index generated() {
        return generated;
    }

    /** True when the checkout declares a type of this name. */
    public boolean declares(String fqn) {
        return index.declared().contains(fqn);
    }

    /** True when a receiver is a name no declaration gives (see {@link Chains#undeclaredName}). */
    public boolean undeclared(CtExpression<?> target) {
        return chains.undeclaredName(target);
    }

    /** The type of a bare name Lombok declared as a field (`log`), or null: only the synthesis knows such a name. */
    public String generatedFieldType(CtType<?> type, String targetText) {
        if (targetText == null || !targetText.matches("[A-Za-z_$][\\w$]*")) return null;
        Lombok.Item field = generated.fields().get(Names.member(Names.qualified(type), targetText));
        return field == null ? null : field.typeFqn();
    }

    /**
     * The receiver's type as a call site gives it: a Lombok field's type for a bare name Lombok declared, else the
     * chain or expression's type, else the declaring type of the method, else the class the call is written in.
     */
    public String receiverOf(CtType<?> type, CtInvocation<?> call, String fieldType) {
        CtExecutableReference<?> ref = call.getExecutable();
        CtExpression<?> target = call.getTarget();
        String receiver = target == null ? null : chains.receiver(target);
        if (receiver == null && fieldType == null && ref != null && ref.getDeclaringType() != null)
            receiver = Names.nameOf(ref.getDeclaringType());
        // A call written without a receiver resolves against the class it is written in (or what that class inherits).
        if (receiver == null && fieldType == null && target == null) receiver = Names.qualified(type);
        if (fieldType != null) receiver = fieldType;
        // A receiver declared as a type parameter (`T row`) is typed as the argument this checkout writes for it, and
        // stays untyped when there is none: a member reached through an open parameter is unresolved.
        if (receiver == null && fieldType == null && target != null)
            receiver = boundType(type, target.getType());
        return receiver;
    }

    /** A method reference's receiver: the same rule as a call's, without the type-parameter binding. */
    public String methodRefReceiver(CtType<?> type, CtExecutableReference<?> ref, CtExpression<?> target) {
        String receiver = target == null ? null : chains.receiver(target);
        if (receiver == null && ref != null && ref.getDeclaringType() != null)
            receiver = Names.nameOf(ref.getDeclaringType());
        if (receiver == null) receiver = Names.qualified(type);
        return receiver;
    }

    /**
     * The receiver judged for a row: an undeclared name (when {@code unnamed}) is invented, and counted under {@code
     * TYPE_UNRESOLVED} like any other type the dump cannot name.
     */
    public Recv recv(CtType<?> written, String type, boolean generatedField, boolean unnamed) {
        boolean declared = type != null && index.declared().contains(type);
        boolean builder = chains.isBuilder(type);
        boolean invented = unnamed || Refs.isInvented(type, declared || builder || generatedField, written);
        if (invented) failures.count(Failures.Key.TYPE_UNRESOLVED);
        return new Recv(type, declared, builder, invented, generatedField);
    }

    /**
     * The declaration, then every implementation of it: a call through an interface reaches each subclass method with
     * the same name and arity, which is the graph a flow has to walk.
     */
    public List<Target> targets(CtExecutableReference<?> ref, String receiver, String name, int argc) {
        List<Target> out = new ArrayList<>();
        if (ref == null) return out;
        if (ref.getDeclaration() instanceof CtConstructor<?> ctor) return constructorTargets(ctor, argc);
        if (!(ref.getDeclaration() instanceof CtMethod<?> method)) return byArity(receiver, name, argc);
        CtType<?> owner = method.getDeclaringType();
        if (owner == null || !index.declared().contains(Names.qualified(owner))) return out;
        // The method's own position can be synthetic (a record accessor); the owner's is the check that matters.
        if (owner.getPosition() == null || !owner.getPosition().isValidPosition()) return out;
        if (syntheticEnum(owner, method.getSimpleName())) return out;
        out.add(new Target(Names.executableId(owner, method), "declared"));
        boolean open = owner.isInterface() || owner.getModifiers().contains(ModifierKind.ABSTRACT);
        if (!open) return out;
        for (String subtype : index.subtypes().getOrDefault(Names.qualified(owner), Set.of()))
            addTarget(out, overrideIn(subtype, method), "override");
        return out;
    }

    /**
     * The Lombok constructor a `new` reaches: the one of its arity, unless the program writes a matching constructor.
     */
    public Lombok.Item lombokConstructor(CtExecutableReference<?> ref, String owner, int argc) {
        if (owner == null || (ref != null && ref.getDeclaration() instanceof CtConstructor<?> c && !c.isImplicit()))
            return null;
        return generated.constructor(owner, argc);
    }

    /** True when a call's resolved declaration belongs to a type declared in this checkout: Spoon answered. */
    public boolean declaredIn(CtExecutableReference<?> ref) {
        CtMethod<?> method = declaration(ref);
        return method != null && method.getDeclaringType() != null
                && index.declared().contains(Names.qualified(method.getDeclaringType()));
    }

    /** True when a call's resolved declaration is a library's, or has no declaring type at all. */
    public boolean libraryTarget(CtExecutableReference<?> ref) {
        CtMethod<?> method = declaration(ref);
        return method != null && (method.getDeclaringType() == null
                || !index.declared().contains(Names.qualified(method.getDeclaringType())));
    }

    /**
     * True when the call reaches an open declaration with no body and exactly one override here: the one case where
     * "the implementation" is a fact. With two overrides it is false, and a reader must not pick one.
     */
    public static boolean uniqueImpl(CtExecutableReference<?> ref, List<Target> targets) {
        int overrides = 0;
        for (Target target : targets) if ("override".equals(target.kind())) overrides++;
        if (overrides != 1 || targets.size() != 2) return false;
        var declaration = ref == null ? null : ref.getDeclaration();
        return declaration instanceof CtMethod<?> method && method.getBody() == null;
    }

    /**
     * How the receiver was reached, in the vocabulary the facts speak: a field, a parameter, a local, a chain, a static
     * type, {@code super}, {@code this}, or nothing written at all (implicit).
     */
    public static String how(CtExpression<?> target) {
        if (target == null) return "implicit";
        if (target instanceof CtTypeAccess<?>) return "static";
        if (target instanceof CtSuperAccess<?>) return "super";
        if (target instanceof CtThisAccess<?>) return "this";
        if (target instanceof CtInvocation<?>) return "chain";
        if (target instanceof CtVariableRead<?> read) {
            var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
            if (declaration instanceof CtField<?>) return "field";
            if (declaration instanceof CtParameter<?> parameter)
                // A lambda's parameter is a parameter to Spoon; the facts distinguish it, so the dump does too.
                return parameter.getParent() instanceof CtLambda<?> ? "lambda" : "param";
            return "local";
        }
        return "expr";
    }

    /** The call's kind as a receiver is reached: static, super, implicit, or an instance. */
    public static String kind(CtInvocation<?> call) {
        CtExecutableReference<?> ref = call.getExecutable();
        if (call.getTarget() == null) return ref != null && ref.isStatic() ? "static" : "implicit";
        if (call.getTarget() instanceof CtSuperAccess<?>) return "super";
        if (call.getTarget() instanceof CtTypeAccess<?>) return "static";
        return "instance";
    }

    /** True when a receiver is a `var` local: an unresolved one is an unknown, not a missing callee. */
    public static boolean varLocal(CtExpression<?> target) {
        if (!(target instanceof CtVariableRead<?> read)) return false;
        var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
        return declaration instanceof CtLocalVariable<?> local && local.isInferred();
    }

    // ---- the index: what a call can be answered from ----

    private static Index index(List<CtType<?>> known, Failures failures) {
        Set<String> declared = new HashSet<>();
        Map<String, CtType<?>> types = new HashMap<>();
        Map<String, Map<String, String>> byShape = new HashMap<>();
        Map<String, Map<String, String>> byArity = new HashMap<>();
        for (CtType<?> t : known) {
            String fqn = Names.qualified(t);
            declared.add(fqn);
            types.put(fqn, t);
            Map<String, String> shapes = new HashMap<>();
            Map<String, String> arities = new HashMap<>();
            shapes(t, shapes, arities);
            byShape.put(fqn, shapes);
            byArity.put(fqn, arities);
        }
        return new Index(types, declared, subtypes(known, declared), supertypes(known, declared), byShape, byArity,
                bindings(known, declared, failures));
    }

    /**
     * One type's members by name and arity. {@code byShape} keeps the first member of each shape; {@code byArity} keeps
     * only the shapes that name one member, and a varargs method also answers to one argument fewer.
     */
    private static void shapes(CtType<?> t, Map<String, String> byShape, Map<String, String> byArity) {
        Set<String> ambiguous = new HashSet<>();
        for (CtExecutable<?> e : Walk.executables(t)) {
            if (syntheticEnum(t, e.getSimpleName())) continue;
            String id = Names.executableId(t, e);
            int n = e.getParameters().size();
            String shape = Names.shape(e.getSimpleName(), n);
            byShape.putIfAbsent(shape, id);
            if (byArity.containsKey(shape)) ambiguous.add(shape);
            else byArity.put(shape, id);
            if (n > 0 && e.getParameters().get(n - 1).isVarArgs())
                byArity.putIfAbsent(Names.shape(e.getSimpleName(), n - 1), id);
        }
        for (String shape : ambiguous) byArity.remove(shape);
        if (t instanceof CtRecord record) recordShapes(record, byShape, byArity, ambiguous);
    }

    /**
     * A record's canonical constructor by arity, and each component's accessor by name. Spoon models no canonical
     * constructor for a nested record: the constructor member is still declared, so a `new` of that arity resolves to
     * it unless another constructor shares the arity.
     */
    private static void recordShapes(CtRecord record, Map<String, String> byShape, Map<String, String> byArity,
            Set<String> ambiguous) {
        String init = Names.shape("<init>", record.getRecordComponents().size());
        if (!byArity.containsKey(init) && !ambiguous.contains(init)) byArity.put(init, RecordCtors.id(record));
        for (CtRecordComponent component : record.getRecordComponents())
            byShape.put(Names.shape(component.getSimpleName(), 0),
                    Names.methodId(record, component.getSimpleName(), List.of()));
    }

    /** Subtypes of every declared type, transitively: a call to an interface lists the types that implement it. */
    private static Map<String, Set<String>> subtypes(List<CtType<?>> known, Set<String> declared) {
        Map<String, Set<String>> subtypes = new HashMap<>();
        for (CtType<?> t : known) {
            String fqn = Names.qualified(t);
            Set<String> seen = new HashSet<>();
            ArrayDeque<CtType<?>> queue = new ArrayDeque<>();
            queue.add(t);
            while (!queue.isEmpty()) {
                for (CtTypeReference<?> s : supers(queue.poll())) {
                    String superFqn = Names.qualified(s);
                    if (!declared.contains(superFqn) || !seen.add(superFqn)) continue;
                    subtypes.computeIfAbsent(superFqn, k -> new TreeSet<>()).add(fqn);
                    CtType<?> declaration = s.getTypeDeclaration();
                    if (declaration != null) queue.add(declaration);
                }
            }
        }
        return subtypes;
    }

    /** The other direction: which declared types a type inherits from, for a call written without a receiver. */
    private static Map<String, Set<String>> supertypes(List<CtType<?>> known, Set<String> declared) {
        Map<String, Set<String>> supertypes = new HashMap<>();
        for (CtType<?> t : known) {
            Set<String> supers = new TreeSet<>();
            for (CtTypeReference<?> superRef : supers(t)) {
                String superFqn = Names.qualified(superRef);
                if (declared.contains(superFqn)) supers.add(superFqn);
            }
            supertypes.put(Names.qualified(t), supers);
        }
        return supertypes;
    }

    /** A type's written supertypes: its interfaces, then its superclass when it is a class with one. */
    private static List<CtTypeReference<?>> supers(CtType<?> t) {
        List<CtTypeReference<?>> out = new ArrayList<>(t.getSuperInterfaces());
        if (t instanceof CtClass<?> c && c.getSuperclass() != null) out.add(c.getSuperclass());
        return out;
    }

    /**
     * The type arguments this checkout settles. {@code VoucherService extends Base<Voucher>} binds {@code Base}'s
     * {@code T} to {@code shop.Voucher}; a type parameter written as the argument, or a type whose subtypes disagree,
     * binds nothing.
     */
    private static Map<String, String> bindings(List<CtType<?>> known, Set<String> declared, Failures failures) {
        Map<String, Set<String>> seen = new HashMap<>();
        for (CtType<?> t : known) {
            try {
                for (CtTypeReference<?> superRef : supers(t)) bindingOf(superRef, declared, seen);
            } catch (RuntimeException e) {
                // One type Spoon cannot read must not cost the dump the bindings of every other type.
                failures.count(Failures.Key.BINDINGS_UNRESOLVED);
            }
        }
        Map<String, String> out = new HashMap<>();
        for (var e : seen.entrySet()) if (e.getValue().size() == 1) out.put(e.getKey(), e.getValue().iterator().next());
        return out;
    }

    private static void bindingOf(CtTypeReference<?> superRef, Set<String> declared, Map<String, Set<String>> seen) {
        CtType<?> declaration = superRef.getTypeDeclaration();
        if (declaration == null || !declared.contains(Names.qualified(declaration))) return;
        List<CtTypeReference<?>> args = superRef.getActualTypeArguments();
        var params = declaration.getFormalCtTypeParameters();
        for (int i = 0; i < params.size() && i < args.size(); i++) {
            CtTypeReference<?> arg = args.get(i);
            if (arg == null || arg instanceof CtTypeParameterReference) continue;
            String fqn = Names.qualified(arg);
            if (!declared.contains(fqn)) continue;
            String key = Names.member(Names.qualified(declaration), params.get(i).getSimpleName());
            seen.computeIfAbsent(key, k -> new TreeSet<>()).add(fqn);
        }
    }

    /**
     * The type a receiver declared as a type parameter has here: the one argument this checkout writes for it, or null.
     * The parameter is looked up on the type the body is written in, or an enclosing one, because a nested type
     * inherits its outer class's parameters.
     */
    private String boundType(CtType<?> type, CtTypeReference<?> reference) {
        if (!(reference instanceof CtTypeParameterReference parameter)) return null;
        for (CtType<?> owner = type; owner != null; owner = owner.getDeclaringType())
            for (var formal : owner.getFormalCtTypeParameters())
                if (formal.getSimpleName().equals(parameter.getSimpleName()))
                    return index.bound().get(Names.member(Names.qualified(owner), parameter.getSimpleName()));
        return null;
    }

    // ---- targets ----

    /**
     * A constructor reached by `new` or by a constructor reference: its own declaration, the only one it can be. Spoon
     * invents a default constructor for a class that writes none, and that one answers only a call with no arguments,
     * and only where Lombok writes no constructor of the class. A record's canonical constructor is never implicit
     * here.
     */
    private List<Target> constructorTargets(CtConstructor<?> ctor, int argc) {
        CtType<?> owner = ctor.getDeclaringType();
        // An anonymous subclass's constructor is its superclass's: `new Base(7) { ... }` reaches `Base(int)`, and an enum
        // constant with a body reaches the enum's own constructor.
        if (owner != null && owner.isAnonymous()) return byArity(Names.nameOf(owner), "<init>", argc);
        if (owner == null || !index.declared().contains(Names.qualified(owner))) return List.of();
        if (owner.getPosition() == null || !owner.getPosition().isValidPosition()) return List.of();
        boolean invented = ctor.isImplicit() && !(owner instanceof CtRecord);
        if (invented && (argc != 0 || generated.constructed(Names.qualified(owner)))) return List.of();
        return List.of(new Target(Names.executableId(owner, ctor), "declared"));
    }

    /**
     * The member of a subtype that overrides {@code method}, by Spoon's own signature check (so {@code take(Integer)}
     * is not the override of {@code take(String)}). A record's accessor is written by the record, not declared, and
     * answers to its component's name with no argument.
     */
    private String overrideIn(String subtype, CtMethod<?> method) {
        CtType<?> sub = index.types().get(subtype);
        if (sub == null) return null;
        for (CtMethod<?> candidate : sub.getMethods())
            if (candidate.getSimpleName().equals(method.getSimpleName()) && candidate.isOverriding(method))
                return Names.executableId(sub, candidate);
        String shape = Names.shape(method.getSimpleName(), method.getParameters().size());
        return sub instanceof CtRecord ? index.byShape().getOrDefault(subtype, Map.of()).get(shape) : null;
    }

    /**
     * A call Spoon refuses to pick an overload for. Inside a project type, name and arity are still a fact when they
     * leave exactly one member, marked by origin and never dressed up as a compiler answer. The call may sit on an
     * inherited member: the nearest declaration wins, one level at a time.
     */
    private List<Target> byArity(String receiver, String name, int argc) {
        List<Target> out = new ArrayList<>();
        if (receiver == null || !index.declared().contains(receiver)) return out;
        List<String> level = List.of(receiver);
        Set<String> seen = new HashSet<>();
        while (!level.isEmpty() && out.isEmpty()) {
            List<String> next = new ArrayList<>();
            for (String owner : level) {
                if (!seen.add(owner)) continue;
                addTarget(out, index.byArity().getOrDefault(owner, Map.of()).get(Names.shape(name, argc)), "declared");
                next.addAll(index.supertypes().getOrDefault(owner, Set.of()));
            }
            level = next;
        }
        return out;
    }

    private static void addTarget(List<Target> out, String id, String kind) {
        if (id != null && out.stream().noneMatch(t -> t.id().equals(id))) out.add(new Target(id, kind));
    }

    /** `values()` and `valueOf(String)` on an enum are compiler-written: never a member, never a target. */
    private static boolean syntheticEnum(CtType<?> owner, String name) {
        return owner.isEnum() && ("values".equals(name) || "valueOf".equals(name));
    }

    private static CtMethod<?> declaration(CtExecutableReference<?> ref) {
        return ref != null && ref.getDeclaration() instanceof CtMethod<?> method ? method : null;
    }
}
