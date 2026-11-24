package a;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.transaction.annotation.Transactional;
public class Ctl {
  private Svc svc;
  @PostMapping("/orders")
  @Transactional
  public void create(Order o) { svc.create(o); }
  @GetMapping("/orders")
  public void read() { svc.read(); }
}
