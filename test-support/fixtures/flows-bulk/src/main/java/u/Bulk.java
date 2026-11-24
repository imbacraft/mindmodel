package u;
import jakarta.inject.Named;
@Named
public class Bulk {
  private W w;
  private H h;
  public void go(Item i) {
    w.a(i);
    w.b(i);
    w.c(i);
    w.d(i);
    w.e(i);
    w.f(i);
    h.ping(i);
    h.ping(i);
  }
}
