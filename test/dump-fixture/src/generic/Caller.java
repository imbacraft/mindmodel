package generic;

public class Caller {
    private OnlyPort only;
    private Port port;

    // One implementation: the dump says uniqueImpl, and a reader may follow it.
    public void single(Row row) {
        only.go(row);
    }

    // Two implementations: the declaration is a fact, the implementation is not.
    public void either(Row row) {
        port.go(row);
    }
}
