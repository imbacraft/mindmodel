package contract;

/** One value handed down two calls, so `argValue`'s one-hop rule and its depth can both be seen. */
public class Chain {
    void entry() {
        middle("literal");
    }

    void unknown(String raw) {
        middle(raw);
    }

    void middle(String value) {
        inner(value);
    }

    void inner(String value) { }
}
