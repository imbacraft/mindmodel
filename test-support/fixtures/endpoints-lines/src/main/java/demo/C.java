package demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class C {

  @GetMapping("/x")
  public String list() {
    return "";
  }

  @GetMapping("/x")
  public String list(int page) {
    return "";
  }

  @RequestMapping(value = "/y", method = RequestMethod.POST)
  public String create() {
    return "";
  }

  @GetMapping(Ids.BASE + "/" + Ids.ID)
  public String built() {
    return "";
  }

  @GetMapping(Elsewhere.PATH)
  public String unknown() {
    return "";
  }
}
