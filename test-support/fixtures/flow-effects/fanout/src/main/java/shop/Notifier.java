package shop;

/** Three implementations live in the fixture: which one runs is decided at runtime, so no single one is a fact. */
public interface Notifier {
    void send(Notice notice);
}
